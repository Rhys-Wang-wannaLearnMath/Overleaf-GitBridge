import * as vscode from 'vscode';
import { execGit } from './gitUtils';

export interface ConflictInfo {
    repoPath: string;
    localAhead: number;
    remoteBehind: number;
    diffSummary: string;
    conflictingFiles?: string[];
    safeFiles?: string[];
}

export interface FileConflictResult {
    /** Files changed both locally and remotely (potential conflict) */
    conflicting: string[];
    /** Files changed only locally */
    localOnly: string[];
    /** Files changed only remotely */
    remoteOnly: string[];
}

/**
 * Detect file-level conflicts between local working tree and remote.
 * Compares which files are modified locally vs remotely.
 */
export async function detectFileConflicts(
    repoPath: string, remote: string, branch: string,
    ignorePatterns: string[] = [],
): Promise<FileConflictResult> {
    // Build a filter function from ignore patterns (glob-style)
    const shouldIgnore = buildIgnoreFilter(ignorePatterns);

    // Local modified/staged/untracked files
    const localTracked = await safeExecGit(repoPath, ['diff', '--name-only', 'HEAD']);
    const localStaged = await safeExecGit(repoPath, ['diff', '--name-only', '--cached']);
    const localUntracked = await safeExecGit(repoPath, ['ls-files', '--others', '--exclude-standard']);
    const localFiles = new Set(
        [...splitLines(localTracked), ...splitLines(localStaged), ...splitLines(localUntracked)]
            .filter(f => !shouldIgnore(f)),
    );

    // Remote changed files since common ancestor
    const remoteChanged = await safeExecGit(repoPath, ['diff', '--name-only', `HEAD...${remote}/${branch}`]);
    const remoteFiles = new Set(splitLines(remoteChanged).filter(f => !shouldIgnore(f)));

    const conflicting: string[] = [];
    const localOnly: string[] = [];
    const remoteOnly: string[] = [];

    for (const f of localFiles) {
        if (remoteFiles.has(f)) {
            conflicting.push(f);
        } else {
            localOnly.push(f);
        }
    }
    for (const f of remoteFiles) {
        if (!localFiles.has(f)) {
            remoteOnly.push(f);
        }
    }

    return { conflicting, localOnly, remoteOnly };
}

/**
 * Build a filter function from glob-style ignore patterns.
 * Supports leading-dot patterns like '.output*' and '.*'.
 */
function buildIgnoreFilter(patterns: string[]): (filePath: string) => boolean {
    if (patterns.length === 0) { return () => false; }

    const regexes = patterns.map(p => {
        // Convert glob to regex: * → [^/]*, ** → .*, ? → [^/]
        let re = p
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars except * and ?
            .replace(/\\\*/g, '@@STAR@@')            // temp placeholder
            .replace(/@@STAR@@@@STAR@@/g, '.*')      // ** → .*
            .replace(/@@STAR@@/g, '[^/]*')            // * → [^/]*
            .replace(/\?/g, '[^/]');
        return new RegExp(`(^|/)${re}(/|$)`);
    });

    return (filePath: string) => regexes.some(re => re.test(filePath));
}

function splitLines(text: string): string[] {
    return text.trim().split(/\r?\n/).filter(l => l.length > 0);
}

async function safeExecGit(cwd: string, args: string[]): Promise<string> {
    try {
        return await execGit(cwd, args);
    } catch {
        return '';
    }
}

export async function getDiffSummary(repoPath: string, remote: string, branch: string): Promise<string> {
    try {
        const result = await execGit(repoPath, ['log', '--oneline', `HEAD..${remote}/${branch}`, '-10']);
        return result.trim() || '(no details available)';
    } catch {
        return '(unable to retrieve diff)';
    }
}

export async function handleConflict(
    info: ConflictInfo,
    outputChannel: vscode.OutputChannel,
): Promise<'pulled' | 'force_pushed' | 'terminal' | 'cancelled'> {
    outputChannel.appendLine(`\n[Conflict] Local is ${info.localAhead} ahead, ${info.remoteBehind} behind remote.`);
    outputChannel.appendLine(`Remote commits:\n${info.diffSummary}`);
    outputChannel.show(true);

    const choice = await vscode.window.showWarningMessage(
        `Overleaf GitLive: Remote has ${info.remoteBehind} new commit(s) and you have ${info.localAhead} local commit(s). How do you want to resolve?`,
        { modal: false },
        'Pull & Merge',
        'Force Push',
        'Open Terminal',
    );

    if (choice === 'Pull & Merge') {
        try {
            const pullResult = await execGit(info.repoPath, ['pull', '--no-rebase', 'origin', 'master']);
            outputChannel.appendLine(`[Pull] ${pullResult}`);
            vscode.window.showInformationMessage('Overleaf GitLive: Pull completed. Please resolve any merge conflicts in the editor.');
            return 'pulled';
        } catch (err: any) {
            outputChannel.appendLine(`[Pull Error] ${err.message}`);
            vscode.window.showErrorMessage(`Overleaf GitLive: Pull failed — ${err.message}. Please resolve manually.`);
            return 'cancelled';
        }
    }

    if (choice === 'Force Push') {
        const confirm = await vscode.window.showWarningMessage(
            'This will OVERWRITE remote changes with your local version. Are you sure?',
            { modal: true },
            'Yes, Force Push',
        );
        if (confirm === 'Yes, Force Push') {
            try {
                // Create backup branch before force push
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const backupBranch = `backup/${ts}`;
                try {
                    await execGit(info.repoPath, ['branch', backupBranch, 'origin/master']);
                    outputChannel.appendLine(`[Backup] Created backup branch: ${backupBranch}`);
                } catch (backupErr: any) {
                    outputChannel.appendLine(`[Backup] Warning: could not create backup branch: ${backupErr.message}`);
                }

                const pushResult = await execGit(info.repoPath, ['push', '--force', 'origin', 'master']);
                outputChannel.appendLine(`[Force Push] ${pushResult}`);
                vscode.window.showInformationMessage(`Overleaf GitLive: Force push completed. Backup: ${backupBranch}`);
                return 'force_pushed';
            } catch (err: any) {
                outputChannel.appendLine(`[Force Push Error] ${err.message}`);
                vscode.window.showErrorMessage(`Overleaf GitLive: Force push failed — ${err.message}`);
                return 'cancelled';
            }
        }
        return 'cancelled';
    }

    if (choice === 'Open Terminal') {
        const terminal = vscode.window.createTerminal({
            name: 'Overleaf Git',
            cwd: info.repoPath,
        });
        terminal.show();
        return 'terminal';
    }

    return 'cancelled';
}
