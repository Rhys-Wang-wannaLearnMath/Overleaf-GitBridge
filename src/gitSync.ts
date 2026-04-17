import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execGit } from './gitUtils';
import { getDiffSummary, detectFileConflicts } from './conflictHandler';

export type SyncStatus = 'idle' | 'watching' | 'committing' | 'pushing' | 'pulling' | 'conflict' | 'error';

export interface CommitEntry {
    sha: string;
    timestamp: string;
    filesChanged: number;
    summary: string;
    files: string[];
    /** current = fully preserved in HEAD; partial = partially overwritten; superseded = fully overwritten; orphaned = not in current branch (e.g. after restore) */
    status: 'current' | 'partial' | 'superseded' | 'orphaned';
}

export interface GitSyncEvents {
    onStatusChange: (status: SyncStatus, message: string) => void;
    onPushSuccess: () => void | Promise<void>;
    onError: (message: string) => void;
    onConflict?: (conflictingFiles: string[], details: import('./conflictHandler').FileConflictResult, diffSummary: string, localAhead: number, remoteBehind: number) => void;
    onMergeComplete?: (mergedFiles: string[]) => void;
    onCommitSuccess?: (entry: CommitEntry) => void;
}

export class GitSyncEngine {
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;
    private busy = false;
    private _inConflict = false;
    private _conflictFiles: string[] = [];
    private _conflictNeedsMerge = false;
    private _lastMarkerLog = false;

    private readonly remote = 'origin';
    private readonly branch = 'master';

    constructor(
        private repoPath: string,
        private pollSeconds: number,
        private events: GitSyncEvents,
        private outputChannel: vscode.OutputChannel,
    ) { }

    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Gated wrapper for onStatusChange. Silently drops emissions when the
     * engine is not running, so in-flight async work (a git push/pull that
     * the user raced with a Stop click) cannot flip the UI back to a
     * non-idle state after the engine has been stopped.
     */
    private emitStatus(status: SyncStatus, message: string): void {
        if (!this.running) { return; }
        this.events.onStatusChange(status, message);
    }

    async start(): Promise<void> {
        if (this.running) { return; }

        const valid = await this.validateRepo();
        if (!valid) { return; }

        await this.ensureGitExclude();

        this.running = true;
        this.emitStatus('watching', 'Sync started');
        this.log('Sync engine started. Watching for changes...');
        this.log(`Rules: poll interval = ${this.pollSeconds}s, commit on detect`);

        this.tick(); // immediate first tick
        this.timer = setInterval(() => this.tick(), this.pollSeconds * 1000);
    }

    get inConflict(): boolean {
        return this._inConflict;
    }

    get conflictFiles(): string[] {
        return this._conflictFiles;
    }

    /**
     * Called when user opens "Merge in Editor".
     * Clears the merge-pending flag so checkConflictResolved() can start
     * scanning for remaining conflict markers and auto-commit when clean.
     */
    notifyMergeActionTaken(): void {
        if (!this._inConflict) { return; }
        this._conflictNeedsMerge = false;
        this.log('[Resolve] Merge action taken — auto-detection enabled.');
    }

    /**
     * Called when user clicks "Mark Resolved".
     * Directly commits and pushes, bypassing the poll loop.
     */
    async markResolved(): Promise<void> {
        if (!this._inConflict) { return; }
        this.log('[Resolve] User clicked Mark Resolved.');

        // Warn if conflict markers remain
        const hasMarkers = this.hasConflictMarkers();
        if (hasMarkers) {
            const proceed = await vscode.window.showWarningMessage(
                'Conflict markers (<<<<<<) still detected in files. Commit anyway?',
                'Yes, commit', 'Cancel',
            );
            if (proceed !== 'Yes, commit') { return; }
        }

        await this.commitConflictResolution();
    }

    /**
     * git add that tolerates gitignore warnings.
     * git add exits non-zero when encountering gitignored files even with
     * pathspec exclusions. We swallow that specific error and continue.
     */
    private async safeAdd(pathspec: string[]): Promise<void> {
        try {
            await execGit(this.repoPath, ['add', '-A', '--', ...pathspec]);
        } catch (err: any) {
            if (err.message.includes('ignored by one of your .gitignore')) {
                this.log('[git add] Skipped gitignored paths, continuing.');
                return;
            }
            throw err;
        }
    }

    /**
     * Resolve conflict by pulling & merging remote changes.
     * Called from sidebar UI.
     */
    async resolveWithPull(): Promise<void> {
        if (!this._inConflict) { return; }
        this.log('[Resolve] User chose Pull & Merge from sidebar.');
        this.emitStatus('pulling', 'Pulling & merging...');

        // First commit local changes so git pull can merge
        try {
            const pathspec = this.buildPathspec();
            await this.safeAdd(pathspec);
            try {
                await execGit(this.repoPath, ['diff', '--cached', '--quiet']);
            } catch {
                const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
                await execGit(this.repoPath, ['commit', '-m', `local: ${timestamp}`]);
                this.log('Committed local changes before pull.');
            }
        } catch (err: any) {
            this.log(`[Pre-pull commit error] ${err.message}`);
            this.emitStatus('conflict', 'Cannot commit local changes — resolve manually');
            return;
        }

        try {
            const result = await execGit(this.repoPath, ['pull', '--no-rebase', this.remote, this.branch]);
            this.log(`[Pull] ${result.trim()}`);
            // Merge done — check if clean merge or still has markers
            this._conflictNeedsMerge = false;
            const stillHasMarkers = this.hasConflictMarkers();
            if (stillHasMarkers) {
                if (this.events.onMergeComplete) {
                    this.events.onMergeComplete(this._conflictFiles);
                }
                this.emitStatus('conflict', 'Merge conflicts — resolve in editor');
                vscode.window.showWarningMessage('Overleaf GitLive: Merge has conflicts. Resolve them in the editor.');
            } else {
                vscode.window.showInformationMessage('Overleaf GitLive: Pull & merge completed successfully.');
            }
        } catch (err: any) {
            this.log(`[Pull Error] ${err.message}`);
            // git pull puts CONFLICT info in stdout, but execGit only captures stderr.
            // Check the actual repo state to determine if a merge with conflicts occurred.
            const hasUnmerged = await this.hasUnmergedFiles();
            const hasMarkers = this.hasConflictMarkers();

            if (hasUnmerged || hasMarkers) {
                // Merge happened but produced conflicts — let user resolve in editor
                this.log('[Pull] Merge conflicts detected in working tree.');
                this._conflictNeedsMerge = false;
                if (this.events.onMergeComplete) {
                    this.events.onMergeComplete(this._conflictFiles);
                }
                this.emitStatus('conflict', 'Merge conflicts — resolve in editor');
            } else {
                // Pull totally failed (e.g. "would be overwritten") — keep waiting
                vscode.window.showErrorMessage(`Overleaf GitLive: Pull failed — ${err.message}`);
                this.emitStatus('conflict', 'Pull failed — try Force Push or Terminal');
            }
        }
    }

    /**
     * Resolve conflict by force pushing local version to remote.
     * Called from sidebar UI.
     */
    async resolveWithForcePush(): Promise<void> {
        if (!this._inConflict) { return; }
        const confirm = await vscode.window.showWarningMessage(
            'This will OVERWRITE remote changes with your local version. Are you sure?',
            { modal: true },
            'Yes, Force Push',
        );
        if (confirm !== 'Yes, Force Push') { return; }

        this.log('[Resolve] User chose Force Push from sidebar.');
        this.emitStatus('pushing', 'Force pushing...');
        try {
            // Backup first
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupBranch = `backup/${ts}`;
            try {
                await execGit(this.repoPath, ['branch', backupBranch, `${this.remote}/${this.branch}`]);
                this.log(`[Backup] Created backup branch: ${backupBranch}`);
            } catch { /* ignore */ }

            // Commit local changes first if needed
            const pathspec = this.buildPathspec();
            await this.safeAdd(pathspec);
            try {
                await execGit(this.repoPath, ['diff', '--cached', '--quiet']);
            } catch {
                const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
                await execGit(this.repoPath, ['commit', '-m', `force: ${timestamp}`]);
            }

            await execGit(this.repoPath, ['push', '--force', this.remote, this.branch]);
            this.log('Force push successful.');
            this._inConflict = false;
            this._conflictFiles = [];
            this._conflictNeedsMerge = false;
            this.emitStatus('watching', 'Resolved (force pushed)');
            vscode.window.showInformationMessage(`Overleaf GitLive: Force push completed. Backup: ${backupBranch}`);
            await this.events.onPushSuccess();
        } catch (err: any) {
            this.log(`[Force Push Error] ${err.message}`);
            vscode.window.showErrorMessage(`Overleaf GitLive: Force push failed — ${err.message}`);
            this.emitStatus('conflict', 'Force push failed');
        }
    }

    /**
     * Open a terminal at the repo path for manual conflict resolution.
     */
    openTerminal(): void {
        const terminal = vscode.window.createTerminal({
            name: 'Overleaf Git',
            cwd: this.repoPath,
        });
        terminal.show();
    }

    stop(): void {
        if (!this.running) { return; }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this._inConflict = false;
        this._conflictFiles = [];
        this._conflictNeedsMerge = false;
        // Emit 'idle' while running is still true so this notification goes
        // through the guard; then flip the flag so any in-flight tick that
        // resumes later has its subsequent emissions silently dropped.
        this.emitStatus('idle', 'Sync stopped');
        this.running = false;
        this.busy = false;
        this.log('Sync engine stopped.');
    }

    private async validateRepo(): Promise<boolean> {
        try {
            await execGit(this.repoPath, ['rev-parse', '--is-inside-work-tree']);
        } catch {
            this.events.onError(`Not a git repository: ${this.repoPath}`);
            return false;
        }

        try {
            const branch = (await execGit(this.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
            if (branch !== this.branch) {
                this.events.onError(`Current branch is "${branch}", expected "${this.branch}". Please switch first.`);
                return false;
            }
        } catch (err: any) {
            this.events.onError(`Branch check failed: ${err.message}`);
            return false;
        }

        try {
            await execGit(this.repoPath, ['remote', 'get-url', this.remote]);
        } catch {
            this.events.onError(`Remote "${this.remote}" not found.`);
            return false;
        }

        return true;
    }

    private async tick(): Promise<void> {
        // Bail if the engine has been stopped since this tick was scheduled.
        if (!this.running || this.busy) { return; }
        this.busy = true;

        try {
            await this.syncCycle();
        } catch (err: any) {
            this.emitStatus('error', err.message);
            this.log(`Error: ${err.message}`);
        }

        this.busy = false;
    }

    private getIgnorePatterns(): string[] {
        const hardcoded = ['.output*'];
        const userPatterns = vscode.workspace
            .getConfiguration('overleaf-gitlive')
            .get<string[]>('ignorePatterns', ['.*']);
        // Merge and deduplicate
        const all = [...hardcoded, ...userPatterns];
        return [...new Set(all)];
    }

    private buildPathspec(): string[] {
        // Build pathspec exclusions: ['.', ':!pattern1', ':!pattern2', ...]
        const patterns = this.getIgnorePatterns();
        return ['.', ...patterns.map(p => `:!${p}`)];
    }

    private async syncCycle(): Promise<void> {
        // If we are in conflict state, check if conflicts are resolved
        if (this._inConflict) {
            await this.checkConflictResolved();
            return;
        }

        const pathspec = this.buildPathspec();
        let status: string;
        try {
            status = (await execGit(this.repoPath, ['status', '--porcelain=v1', '--', ...pathspec])).trim();
        } catch (err: any) {
            this.log(`git status failed: ${err.message}`);
            return;
        }

        // --- No local changes: check remote for new commits ---
        if (!status) {
            await this.checkAndPullRemote();
            return;
        }

        // --- Local changes detected ---

        // Also fetch remote to detect Overleaf collaborator changes early
        await this.fetchRemoteSilent();
        const counts = await this.getAheadBehind();

        if (counts.behind > 0) {
            await this.handleRemoteChangesWithLocalEdits(counts);
            return;
        }

        // --- No remote changes: commit immediately ---
        this.log('Local changes detected. Committing immediately...');
        await this.commitAndPush();
    }

    private getConflictStrategy(): string {
        return vscode.workspace
            .getConfiguration('overleaf-gitlive')
            .get<string>('conflictStrategy', 'smart-merge');
    }

    /**
     * Handle the case where remote has new commits AND we have local uncommitted changes.
     * Respects the user's conflictStrategy setting.
     */
    private async handleRemoteChangesWithLocalEdits(
        counts: { ahead: number; behind: number },
    ): Promise<void> {
        const strategy = this.getConflictStrategy();
        this.log(`Remote has ${counts.behind} new commit(s) while local changes exist. Strategy: ${strategy}`);

        // always-ask: never auto-merge, always prompt
        if (strategy === 'always-ask') {
            await this.enterConflictFlow(counts);
            return;
        }

        const fileResult = await detectFileConflicts(this.repoPath, this.remote, this.branch, this.getIgnorePatterns());

        if (fileResult.conflicting.length === 0) {
            // No file overlap — safe auto-merge regardless of strategy
            this.log(`No file overlap. Safe auto-merge (remote: ${fileResult.remoteOnly.length} files, local: ${fileResult.localOnly.length} files)`);
            await this.safeAutoMerge();
            return;
        }

        // Same-file conflict exists
        this.log(`File conflict detected! Overlapping files: ${fileResult.conflicting.join(', ')}`);

        if (strategy === 'local-first') {
            // Keep local version, commit and force push
            this.log('Strategy: local-first. Committing local and force pushing...');
            this.emitStatus('pushing', 'Local-first: force pushing...');
            try {
                const pathspec = this.buildPathspec();
                await this.safeAdd(pathspec);
                try {
                    await execGit(this.repoPath, ['diff', '--cached', '--quiet']);
                } catch {
                    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
                    await execGit(this.repoPath, ['commit', '-m', `local-first: ${timestamp}`]);
                }
                await execGit(this.repoPath, ['push', '--force', this.remote, this.branch]);
                this.log('Local-first force push successful.');
                this.emitStatus('watching', 'Synced (local-first)');
                this.resetPending();
                await this.events.onPushSuccess();
            } catch (err: any) {
                this.log(`Local-first push failed: ${err.message}`);
                this.emitStatus('error', 'Local-first push failed');
            }
            return;
        }

        if (strategy === 'remote-first') {
            // Discard local changes on conflicting files, pull remote
            this.log('Strategy: remote-first. Discarding local changes on conflicting files.');
            this.emitStatus('pulling', 'Remote-first: pulling...');
            try {
                // Checkout remote versions of conflicting files
                for (const f of fileResult.conflicting) {
                    await execGit(this.repoPath, ['checkout', `${this.remote}/${this.branch}`, '--', f]);
                }
                // Pull remaining
                await this.safeAutoMerge();
            } catch (err: any) {
                this.log(`Remote-first failed: ${err.message}`);
                this.emitStatus('error', 'Remote-first merge failed');
            }
            return;
        }

        // smart-merge (default): pause and show diff for same-file conflicts
        await this.enterConflictFlow(counts);
    }

    /**
     * Enter conflict state: set state and let the sidebar UI handle resolution.
     * No popup — the sidebar shows buttons directly.
     */
    private async enterConflictFlow(
        counts: { ahead: number; behind: number },
    ): Promise<void> {
        const fileResult = await detectFileConflicts(this.repoPath, this.remote, this.branch, this.getIgnorePatterns());
        const conflicting = fileResult.conflicting.length > 0
            ? fileResult.conflicting
            : [...new Set([...fileResult.localOnly, ...fileResult.remoteOnly])];

        this._inConflict = true;
        this._conflictFiles = conflicting;
        this._conflictNeedsMerge = true;

        const diffSummary = await getDiffSummary(this.repoPath, this.remote, this.branch);
        this.emitStatus('conflict', `Conflict in ${conflicting.length} file(s)`);

        if (this.events.onConflict) {
            this.events.onConflict(conflicting, fileResult, diffSummary, counts.ahead, counts.behind);
        }

        this.outputChannel.appendLine(`\n[Conflict] Local is ${counts.ahead} ahead, ${counts.behind} behind remote.`);
        this.outputChannel.appendLine(`Remote commits:\n${diffSummary}`);
        this.outputChannel.appendLine(`Conflicting files: ${conflicting.join(', ')}`);
        this.outputChannel.show(true);

        this.resetPending();
    }

    /**
     * Stash local changes, pull remote, then pop stash.
     * Used when remote and local modify different files.
     */
    private async safeAutoMerge(): Promise<void> {
        this.emitStatus('pulling', 'Auto-merging (safe)...');
        try {
            await execGit(this.repoPath, ['stash', 'push', '-m', 'overleaf-gitlive-auto']);
            this.log('Stashed local changes.');
        } catch (err: any) {
            this.log(`Stash failed: ${err.message}. Skipping auto-merge.`);
            return;
        }

        try {
            await execGit(this.repoPath, ['pull', '--ff-only', this.remote, this.branch]);
            this.log('Pulled remote changes (ff-only).');
        } catch (err: any) {
            this.log(`Pull after stash failed: ${err.message}. Popping stash.`);
            try { await execGit(this.repoPath, ['stash', 'pop']); } catch { /* ignore */ }
            this.emitStatus('error', 'Auto-merge pull failed');
            return;
        }

        try {
            await execGit(this.repoPath, ['stash', 'pop']);
            this.log('Popped stash. Local + remote changes merged.');
            this.emitStatus('watching', 'Auto-merged remote changes');
        } catch (err: any) {
            this.log(`Stash pop failed (unexpected conflict): ${err.message}`);
            this.emitStatus('conflict', 'Stash pop conflict');
        }
    }

    /**
     * Check if conflict markers have been resolved in all conflicting files.
     * If resolved, auto-commit and push, then resume watching.
     */
    private async checkConflictResolved(): Promise<void> {
        // If user hasn't initiated a merge yet, wait for sidebar action
        if (this._conflictNeedsMerge) {
            return;
        }

        // Check for conflict markers in working tree files
        const hasMarkers = this.hasConflictMarkers();
        if (hasMarkers) {
            // Log details only once, not every tick
            if (!this._lastMarkerLog) {
                this._lastMarkerLog = true;
            }
            return;
        }
        this._lastMarkerLog = false;

        // No conflict markers — stage resolved files to clear unmerged state
        if (await this.hasUnmergedFiles()) {
            await this.addConflictFiles();
            if (await this.hasUnmergedFiles()) {
                this.log('[checkConflict] Still has unmerged files after add.');
                return;
            }
        }

        // All resolved — commit and push
        await this.commitConflictResolution();
    }

    /**
     * Add conflict files by name to avoid gitignore pathspec issues.
     */
    private async addConflictFiles(): Promise<void> {
        // Add conflict files explicitly by name
        for (const file of this._conflictFiles) {
            try {
                await execGit(this.repoPath, ['add', '--', file]);
            } catch (err: any) {
                this.log(`[add] Could not add ${file}: ${err.message}`);
            }
        }
        // Also try general add for any other changed files
        try {
            await this.safeAdd(this.buildPathspec());
        } catch { /* ignore */ }
    }

    /**
     * Commit the conflict resolution and push.
     * Handles MERGE_HEAD: always commits when a merge is in progress.
     */
    private async commitConflictResolution(): Promise<void> {
        this.log('Committing conflict resolution...');
        this.emitStatus('committing', 'Committing resolution...');

        try {
            await this.addConflictFiles();

            // Always commit if MERGE_HEAD exists (merge in progress)
            const mergeInProgress = this.hasMergeHead();
            let needsCommit = mergeInProgress;

            if (!needsCommit) {
                // Check for staged changes
                try {
                    await execGit(this.repoPath, ['diff', '--cached', '--quiet']);
                } catch {
                    needsCommit = true;
                }
            }

            if (needsCommit) {
                const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
                await execGit(this.repoPath, ['commit', '-m', `resolved: ${timestamp}`]);
                this.log('Committed conflict resolution.');
            } else {
                this.log('Nothing to commit, pushing existing commits.');
            }

            await this.doPush();
            this._inConflict = false;
            this._conflictFiles = [];
            this._conflictNeedsMerge = false;
            this.emitStatus('watching', 'Conflict resolved');
        } catch (err: any) {
            this.log(`Conflict resolution commit/push failed: ${err.message}`);
            this.emitStatus('conflict', 'Push failed after resolve');
        }
    }

    private hasMergeHead(): boolean {
        return fs.existsSync(path.join(this.repoPath, '.git', 'MERGE_HEAD'));
    }

    private async getConflictFileList(): Promise<string[]> {
        try {
            const result = (await execGit(this.repoPath, ['diff', '--name-only', '--diff-filter=U'])).trim();
            return result ? result.split(/\r?\n/) : [];
        } catch {
            return [];
        }
    }

    private async hasUnmergedFiles(): Promise<boolean> {
        try {
            const unmerged = (await execGit(this.repoPath, ['ls-files', '--unmerged'])).trim();
            return unmerged.length > 0;
        } catch {
            return false;
        }
    }

    private hasConflictMarkers(): boolean {
        // Read files directly from disk — more reliable than git grep
        // which can be affected by index state.
        const filesToCheck = this._conflictFiles.length > 0
            ? this._conflictFiles
            : [];

        if (filesToCheck.length === 0) {
            return false;
        }

        for (const file of filesToCheck) {
            const fullPath = path.join(this.repoPath, file);
            try {
                const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
                const markers: string[] = [];
                for (let i = 0; i < lines.length; i++) {
                    if (/^<{7}|^={7}|^>{7}/.test(lines[i])) {
                        markers.push(`  line ${i + 1}: ${lines[i].slice(0, 80)}`);
                    }
                }
                if (markers.length > 0) {
                    this.log(`[hasConflictMarkers] ${file}: ${markers.length} marker(s):\n${markers.join('\n')}`);
                    return true;
                }
            } catch {
                // File doesn't exist or can't be read — skip
            }
        }
        return false;
    }

    private async fetchRemoteSilent(): Promise<void> {
        try {
            await execGit(this.repoPath, ['fetch', this.remote, `+refs/heads/${this.branch}:refs/remotes/${this.remote}/${this.branch}`, '--quiet']);
        } catch (err: any) {
            this.log(`Fetch failed: ${err.message}`);
        }
    }

    private async checkAndPullRemote(): Promise<void> {
        // Use force-fetch (+refspec) so the tracking ref is always updated,
        // even after a remote force-push (e.g. Overleaf "Restore" old version).
        try {
            await execGit(this.repoPath, ['fetch', this.remote, `+refs/heads/${this.branch}:refs/remotes/${this.remote}/${this.branch}`, '--quiet']);
        } catch (err: any) {
            this.log(`Fetch failed: ${err.message}`);
            return;
        }

        // Detect remote history rewrite (Overleaf restore):
        // If local HEAD is NOT an ancestor of origin/master, remote was force-pushed.
        const remoteRewritten = await this.isRemoteRewritten();

        const counts = await this.getAheadBehind();

        // Record HEAD before any pull/reset so we can emit pulled commits afterwards
        let headBefore: string | undefined;
        try {
            headBefore = (await execGit(this.repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
        } catch { /* ignore */ }

        if (remoteRewritten) {
            // Remote history was rewritten (e.g. Overleaf restore via force-push).
            // Local has no uncommitted changes (we're in the no-status branch),
            // so we can safely reset to the remote.
            this.log(`Remote history rewritten (Overleaf restore?). Local ahead=${counts.ahead}, behind=${counts.behind}. Resetting to remote...`);
            this.emitStatus('pulling', 'Remote restored — resetting to remote...');
            try {
                await execGit(this.repoPath, ['reset', '--hard', `${this.remote}/${this.branch}`]);
                this.log('Reset to remote successful after history rewrite.');
                await this.emitPulledCommits(headBefore);
                this.emitStatus('watching', 'Synced (remote restored)');
            } catch (err: any) {
                this.log(`Reset to remote failed: ${err.message}`);
                this.emitStatus('error', 'Reset to remote failed');
            }
            return;
        }

        if (counts.behind > 0 && counts.ahead === 0) {
            this.emitStatus('pulling', 'Pulling remote changes...');
            this.log(`Remote has ${counts.behind} new commit(s). Auto-pulling...`);
            try {
                const result = await execGit(this.repoPath, ['pull', '--ff-only', this.remote, this.branch]);
                this.log(`Pull successful: ${result.trim()}`);
                await this.emitPulledCommits(headBefore);
                this.emitStatus('watching', 'Pulled remote changes');
            } catch (err: any) {
                this.log(`Auto-pull failed: ${err.message}`);
                this.emitStatus('error', 'Pull failed');
            }
        } else if (counts.behind === 0) {
            this.emitStatus('watching', 'Synced');
        } else {
            // ahead > 0 && behind > 0 with clean working tree:
            // local commits exist but remote also has new commits — try merge
            this.log(`Diverged: ${counts.ahead} ahead, ${counts.behind} behind (clean working tree).`);
            this.emitStatus('pulling', 'Merging diverged branches...');
            try {
                await execGit(this.repoPath, ['pull', '--no-rebase', this.remote, this.branch]);
                this.log('Merge successful. Pushing...');
                await this.emitPulledCommits(headBefore);
                await this.doPush();
            } catch (err: any) {
                this.log(`Merge failed: ${err.message}`);
                // Merge conflict — enter sidebar conflict flow
                const hasMarkers = this.hasConflictMarkers();
                if (hasMarkers || await this.hasUnmergedFiles()) {
                    this.log('Merge produced conflicts. Entering conflict flow.');
                    this._inConflict = true;
                    this._conflictFiles = await this.getConflictFileList();
                    this._conflictNeedsMerge = false; // merge already happened
                    if (this.events.onMergeComplete) {
                        this.events.onMergeComplete(this._conflictFiles);
                    }
                    this.emitStatus('conflict', 'Merge conflicts — resolve in editor');
                } else {
                    await this.enterConflictFlow(counts);
                }
            }
        }
    }

    /**
     * After a pull/reset, enumerate commits between oldHead and new HEAD
     * and fire onCommitSuccess for each so they appear in commit history.
     */
    private async emitPulledCommits(oldHead?: string): Promise<void> {
        if (!this.events.onCommitSuccess || !oldHead) { return; }
        try {
            const newHead = (await execGit(this.repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
            if (newHead === oldHead) { return; }

            // Get commits from oldHead (exclusive) to HEAD, oldest first
            const log = (await execGit(this.repoPath, [
                'log', '--format=%h|%aI|%s', '--reverse', `${oldHead}..HEAD`,
            ])).trim();
            if (!log) { return; }

            for (const line of log.split(/\r?\n/)) {
                const pipeIdx = line.indexOf('|');
                const pipeIdx2 = line.indexOf('|', pipeIdx + 1);
                if (pipeIdx < 0 || pipeIdx2 < 0) { continue; }
                const sha = line.substring(0, pipeIdx);
                const isoTime = line.substring(pipeIdx + 1, pipeIdx2);
                const msg = line.substring(pipeIdx2 + 1);

                let files: string[] = [];
                let filesChanged = 0;
                let summary = '';
                try {
                    const nameOnly = (await execGit(this.repoPath, ['diff', '--name-only', `${sha}~1`, sha])).trim();
                    files = nameOnly ? nameOnly.split(/\r?\n/) : [];
                    filesChanged = files.length;
                    const numstat = (await execGit(this.repoPath, ['diff', '--numstat', `${sha}~1`, sha])).trim();
                    const parts: string[] = [];
                    if (numstat) {
                        for (const ns of numstat.split(/\r?\n/)) {
                            const [a, d, f] = ns.split(/\t/);
                            if (f) { parts.push(`+${a} -${d} ${f}`); }
                        }
                    }
                    summary = parts.length > 0 ? parts.join(', ') : msg;
                } catch {
                    summary = msg;
                }

                const time = new Date(isoTime).toLocaleTimeString();
                this.events.onCommitSuccess({
                    sha,
                    timestamp: `${time} [remote]`,
                    filesChanged,
                    summary,
                    files,
                    status: 'current',
                });
            }
        } catch (err: any) {
            this.log(`emitPulledCommits failed: ${err.message}`);
        }
    }

    /**
     * Detect if remote history was rewritten (e.g. Overleaf Restore).
     * Returns true if origin/branch is NOT a descendant of HEAD
     * (i.e. remote was force-pushed to an older or divergent commit).
     */
    private async isRemoteRewritten(): Promise<boolean> {
        try {
            // merge-base --is-ancestor A B => exit 0 if A is ancestor of B
            // We check: is origin/master an ancestor of HEAD?
            // If YES => normal (remote is behind or equal) => not rewritten
            // We also check: is HEAD an ancestor of origin/master?
            // If YES => normal fast-forward => not rewritten
            // If NEITHER => diverged / rewritten
            try {
                await execGit(this.repoPath, ['merge-base', '--is-ancestor', `${this.remote}/${this.branch}`, 'HEAD']);
                // origin/master is ancestor of HEAD => local is ahead, not rewritten
                return false;
            } catch { /* not an ancestor */ }

            try {
                await execGit(this.repoPath, ['merge-base', '--is-ancestor', 'HEAD', `${this.remote}/${this.branch}`]);
                // HEAD is ancestor of origin/master => normal fast-forward
                return false;
            } catch { /* not an ancestor */ }

            // Neither is ancestor of the other — histories have diverged.
            // This typically means force-push (Overleaf restore).
            return true;
        } catch {
            return false;
        }
    }

    private async commitAndPush(): Promise<void> {
        this.emitStatus('committing', 'Committing...');

        try {
            const pathspec = this.buildPathspec();
            await this.safeAdd(pathspec);
        } catch (err: any) {
            this.log(`git add failed: ${err.message}`);
            this.emitStatus('error', 'git add failed');
            return;
        }

        // Check if there are actually staged changes
        try {
            await execGit(this.repoPath, ['diff', '--cached', '--quiet']);
            // If no error, there are no staged changes
            this.log('No staged changes after git add. Skipping.');
            this.resetPending();
            return;
        } catch {
            // diff --cached --quiet exits with 1 when there ARE changes — this is good
        }

        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const commitMsg = `auto: ${timestamp}`;
        try {
            await execGit(this.repoPath, ['commit', '-m', commitMsg]);
            this.log(`Committed: ${commitMsg}`);
        } catch (err: any) {
            this.log(`Commit failed: ${err.message}`);
            this.emitStatus('error', 'Commit failed');
            this.resetPending();
            return;
        }

        // Fire onCommitSuccess with commit info
        if (this.events.onCommitSuccess) {
            try {
                const sha = (await execGit(this.repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
                const stat = (await execGit(this.repoPath, ['diff', '--stat', 'HEAD~1', 'HEAD'])).trim();
                const nameOnly = (await execGit(this.repoPath, ['diff', '--name-only', 'HEAD~1', 'HEAD'])).trim();
                const filesList = nameOnly ? nameOnly.split(/\r?\n/) : [];
                const filesChanged = filesList.length;
                // Build a compact summary: "+N -M file" for each changed file
                const numstat = (await execGit(this.repoPath, ['diff', '--numstat', 'HEAD~1', 'HEAD'])).trim();
                const summaryParts: string[] = [];
                if (numstat) {
                    for (const line of numstat.split(/\r?\n/)) {
                        const [added, deleted, file] = line.split(/\t/);
                        if (file) {
                            summaryParts.push(`+${added} -${deleted} ${file}`);
                        }
                    }
                }
                this.events.onCommitSuccess({
                    sha,
                    timestamp: new Date().toLocaleTimeString(),
                    filesChanged,
                    summary: summaryParts.join(', ') || stat,
                    files: filesList,
                    status: 'current',
                });
            } catch { /* best-effort */ }
        }

        // Fetch before push to check for conflicts
        try {
            await execGit(this.repoPath, ['fetch', this.remote, `+refs/heads/${this.branch}:refs/remotes/${this.remote}/${this.branch}`, '--quiet']);
        } catch (err: any) {
            this.log(`Fetch failed before push: ${err.message}`);
            this.emitStatus('error', 'Fetch failed');
            this.resetPending();
            return;
        }

        const counts = await this.getAheadBehind();

        if (counts.behind > 0) {
            // Remote has new commits since we committed — enter conflict flow via sidebar
            this.log(`Post-commit conflict: local ${counts.ahead} ahead, remote ${counts.behind} behind.`);
            await this.enterConflictFlow(counts);
            this.resetPending();
            return;
        }

        // No conflict, push
        await this.doPush();
        this.resetPending();
    }

    private async doPush(): Promise<void> {
        this.emitStatus('pushing', 'Pushing...');
        try {
            await execGit(this.repoPath, ['push', this.remote, this.branch]);
            this.log('Push successful.');
            this.emitStatus('watching', 'Synced');
            await this.events.onPushSuccess();
        } catch (err: any) {
            const msg = (err.message || '').toLowerCase();
            const isRejected = msg.includes('non-fast-forward')
                || msg.includes('rejected')
                || msg.includes('fetch first')
                || msg.includes('failed to push');

            if (isRejected) {
                this.log('Push rejected (remote has new commits). Attempting auto pull --rebase...');
                this.emitStatus('pulling', 'Pull & rebase...');
                try {
                    await execGit(this.repoPath, ['pull', '--rebase', this.remote, this.branch]);
                    this.log('Rebase successful. Retrying push...');
                    this.emitStatus('pushing', 'Retrying push...');
                    await execGit(this.repoPath, ['push', this.remote, this.branch]);
                    this.log('Push successful after rebase.');
                    this.emitStatus('watching', 'Synced');
                    await this.events.onPushSuccess();
                } catch (rebaseErr: any) {
                    // Rebase failed (real conflict) — abort and enter sidebar conflict flow
                    this.log(`Auto rebase failed: ${rebaseErr.message}`);
                    try { await execGit(this.repoPath, ['rebase', '--abort']); } catch { /* ignore */ }
                    const counts = await this.getAheadBehind();
                    await this.enterConflictFlow(counts);
                }
            } else {
                this.log(`Push failed: ${err.message}`);
                this.emitStatus('error', 'Push failed');
            }
        }
    }

    private async getAheadBehind(): Promise<{ ahead: number; behind: number }> {
        try {
            const counts = (await execGit(this.repoPath, [
                'rev-list', '--left-right', '--count', `HEAD...${this.remote}/${this.branch}`,
            ])).trim();
            const parts = counts.split(/\s+/);
            return { ahead: parseInt(parts[0] || '0', 10), behind: parseInt(parts[1] || '0', 10) };
        } catch {
            return { ahead: 0, behind: 0 };
        }
    }

    private resetPending(): void {
        // no-op kept for call-site compatibility
    }

    private async ensureGitExclude(): Promise<void> {
        const excludePath = path.join(this.repoPath, '.git', 'info', 'exclude');
        const patterns = this.getIgnorePatterns();
        try {
            // Ensure .git/info directory exists
            const infoDir = path.dirname(excludePath);
            if (!fs.existsSync(infoDir)) {
                fs.mkdirSync(infoDir, { recursive: true });
            }

            let content = '';
            if (fs.existsSync(excludePath)) {
                content = fs.readFileSync(excludePath, 'utf-8');
            }

            const existingLines = new Set(content.split(/\r?\n/).map(l => l.trim()));
            const toAdd = patterns.filter(p => !existingLines.has(p));

            if (toAdd.length > 0) {
                const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
                const block = `${suffix}# Overleaf GitLive managed\n${toAdd.join('\n')}\n`;
                fs.writeFileSync(excludePath, content + block, 'utf-8');
                this.log(`Updated .git/info/exclude: added ${toAdd.join(', ')}`);
            }
        } catch (err: any) {
            this.log(`Warning: could not update .git/info/exclude: ${err.message}`);
        }
    }

    private log(msg: string): void {
        const ts = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${ts}] ${msg}`);
    }
}
