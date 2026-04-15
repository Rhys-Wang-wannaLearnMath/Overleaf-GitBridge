import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Credentials, Identity, loginWithCookies, fetchProjects } from './api';
import { PdfPoller } from './poller';
import { AuthStore } from './auth';
import { GitSyncEngine, SyncStatus, CommitEntry } from './gitSync';
import { CloneManager } from './cloneManager';
import { execGit, getRemoteUrl, isOverleafRepo } from './gitUtils';
import * as os from 'os';
import { SidebarProvider } from './sidebarView';
import { registerFormatter } from './latexFormatter';
import { SessionManager } from './sessionManager';
import { openConflictDiffs, openInteractiveMerge, cleanupDiffTmpFiles } from './conflictDiffView';
import { ConflictMarkerScanner } from './conflictMarkerScanner';

let authStore: AuthStore;
let sessionManager: SessionManager | undefined;
let poller: PdfPoller | undefined;
let conflictScanner: ConflictMarkerScanner;
let syncEngine: GitSyncEngine | undefined;
let syncStatusBar: vscode.StatusBarItem | undefined;
let pdfStatusBar: vscode.StatusBarItem | undefined;
let outputPdfPath: string | undefined;
let outputChannel: vscode.OutputChannel;
let sidebar: SidebarProvider;
const commitHistory: CommitEntry[] = [];
const MAX_COMMIT_HISTORY = 50;
let enrichTimer: ReturnType<typeof setTimeout> | undefined;

// ── Helpers ──

async function promptInput(prompt: string, placeHolder: string, password = false, value?: string): Promise<string | undefined> {
    return vscode.window.showInputBox({ prompt, placeHolder, password, value, ignoreFocusOut: true });
}

function getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('overleaf-gitlive').get<T>(key, fallback);
}

function updateSyncStatusBar(status: SyncStatus, message: string) {
    if (!syncStatusBar) { return; }
    const icons: Record<SyncStatus, string> = {
        idle: '$(circle-slash)',
        watching: '$(eye)',
        committing: '$(git-commit)',
        pushing: '$(cloud-upload)',
        pulling: '$(cloud-download)',
        conflict: '$(warning)',
        error: '$(error)',
    };
    syncStatusBar.text = `${icons[status] || '$(sync)'} ${message}`;
    syncStatusBar.show();
}

function updatePdfStatusBar(text: string) {
    if (pdfStatusBar) {
        pdfStatusBar.text = `$(file-pdf) ${text}`;
        pdfStatusBar.show();
    }
}

async function savePdfAndOpen(pdfBuffer: Buffer, pdfPath: string) {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const uri = vscode.Uri.file(pdfPath);
    const alreadyOpen = vscode.window.tabGroups.all.some(tg =>
        tg.tabs.some(tab => {
            const input = tab.input as any;
            return input?.uri?.fsPath === pdfPath;
        })
    );
    if (!alreadyOpen) {
        await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.Beside);
    }
}

async function getOutputDir(): Promise<string | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let dir: string;
    if (ws) {
        dir = path.join(ws, '.output');
    } else {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select output folder for PDF',
        });
        if (!picked || picked.length === 0) { return undefined; }
        dir = path.join(picked[0].fsPath, '.output');
    }
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    return dir;
}

async function detectOverleafProject(): Promise<boolean> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { return false; }
    const remoteUrl = await getRemoteUrl(ws);
    return !!remoteUrl && isOverleafRepo(remoteUrl);
}

function extractProjectIdFromUrl(remoteUrl: string): string | undefined {
    const match = remoteUrl.match(/git\.overleaf\.com\/([a-f0-9]+)/);
    return match?.[1];
}

// ── Credentials for PDF preview ──

async function collectCredentials(): Promise<Credentials | undefined> {
    let serverUrl = await authStore.getServerUrl();
    if (!serverUrl) {
        serverUrl = await promptInput('Overleaf Server URL', '', false, 'https://www.overleaf.com');
        if (!serverUrl) { return undefined; }
        serverUrl = serverUrl.replace(/\/+$/, '');
        await authStore.saveServerUrl(serverUrl);
    }

    let cookie = await authStore.getCookie();
    if (!cookie) {
        let cookieInput = await promptInput('Overleaf Cookie (paste cookie value)', 'Paste your overleaf_session2 cookie value', true);
        if (!cookieInput) { return undefined; }
        if (!cookieInput.includes('overleaf_session2=')) {
            cookieInput = `overleaf_session2=${cookieInput}`;
        }
        cookie = cookieInput;
    }

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Overleaf GitLive: Logging in...' },
        () => loginWithCookies(serverUrl!, cookie!),
    );

    if (!result.success || !result.creds) {
        vscode.window.showErrorMessage(`Overleaf GitLive: ${result.error || 'Login failed. Check your cookies.'}`);
        await authStore.saveCookie('');
        return undefined;
    }

    await authStore.saveCookie(cookie);
    vscode.window.showInformationMessage('Overleaf GitLive: Login successful!');
    return result.creds;
}

async function pickProject(creds: Credentials): Promise<{ id: string; name: string } | undefined> {
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Overleaf GitLive: Fetching projects...' },
        () => fetchProjects(creds),
    );

    if (!result.success || !result.projects?.length) {
        vscode.window.showErrorMessage(`Overleaf GitLive: ${result.error || 'No projects found.'}`);
        return undefined;
    }

    const items = result.projects
        .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
        .map(p => ({
            label: p.name,
            description: p.id,
            detail: `Last updated: ${new Date(p.lastUpdated).toLocaleString()}`,
            projectId: p.id,
        }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a project',
        matchOnDescription: true,
        ignoreFocusOut: true,
    });

    return picked ? { id: picked.projectId, name: picked.label } : undefined;
}

// ── Activate ──

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Overleaf GitLive');
    authStore = new AuthStore(context.secrets);

    // Conflict Marker Scanner
    conflictScanner = new ConflictMarkerScanner();
    context.subscriptions.push({ dispose: () => conflictScanner.dispose() });

    // LaTeX Formatter
    registerFormatter(context);

    // Sidebar Webview
    sidebar = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar),
    );

    // Sidebar message handler for parameterized commands (e.g. viewRangeDiff)
    sidebar.onMessage(async (msg: any) => {
        if (msg.type === 'viewRangeDiff') {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws && msg.fromSha && msg.toSha) {
                await openRangeDiff(ws, msg.fromSha, msg.toSha);
            }
        }
    });

    // Status bars
    syncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -9);
    syncStatusBar.command = 'overleaf-gitlive.stopSync';
    context.subscriptions.push(syncStatusBar);

    pdfStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -10);
    pdfStatusBar.command = 'overleaf-gitlive.stopPdfPreview';
    context.subscriptions.push(pdfStatusBar);

    // Initialize sidebar credential state
    refreshSidebarCredentials();

    // ── Clone Project ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.cloneProject', async () => {
            const cloneManager = new CloneManager(authStore, outputChannel);
            await cloneManager.cloneProject();
        }),
    );

    // ── Configure Token ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.configureToken', async () => {
            const token = await promptInput('Enter Overleaf Git token', 'From Account Settings → Git Integration', true);
            if (token) {
                await authStore.saveToken(token);
                vscode.window.showInformationMessage('Overleaf GitLive: Git token saved.');
                refreshSidebarCredentials();
            }
        }),
    );

    // ── Configure Cookie ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.configureCookie', async () => {
            let cookie = await promptInput('Enter Overleaf Cookie', 'Paste overleaf_session2 value', true);
            if (cookie) {
                if (!cookie.includes('overleaf_session2=')) {
                    cookie = `overleaf_session2=${cookie}`;
                }
                await authStore.saveCookie(cookie);
                vscode.window.showInformationMessage('Overleaf GitLive: Cookie saved.');
                refreshSidebarCredentials();
            }
        }),
    );

    // ── Clear Credentials ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.clearCredentials', async () => {
            await authStore.clearAll();
            vscode.window.showInformationMessage('Overleaf GitLive: All credentials cleared.');
            refreshSidebarCredentials();
        }),
    );

    // ── Start Sync ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.startSync', async () => {
            if (syncEngine?.isRunning) {
                vscode.window.showInformationMessage('Overleaf GitLive: Sync is already running.');
                return;
            }

            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!ws) {
                vscode.window.showErrorMessage('Overleaf GitLive: No workspace folder open.');
                return;
            }

            const isOverleaf = await detectOverleafProject();
            if (!isOverleaf) {
                const action = await vscode.window.showWarningMessage(
                    'Overleaf GitLive: This does not appear to be an Overleaf Git project.',
                    'Clone a Project',
                    'Start Anyway',
                );
                if (action === 'Clone a Project') {
                    await vscode.commands.executeCommand('overleaf-gitlive.cloneProject');
                    return;
                }
                if (action !== 'Start Anyway') { return; }
            }

            const pollSeconds = getConfig<number>('pollSeconds', 1);

            syncEngine = new GitSyncEngine(ws, pollSeconds, {
                onStatusChange: (status, message) => {
                    updateSyncStatusBar(status, message);
                    sidebar.setSyncStatus(status, message);
                    // Clean up conflict state when leaving conflict status
                    if (status !== 'conflict') {
                        conflictScanner.clear();
                        cleanupDiffTmpFiles();
                        sidebar.clearConflict();
                    }
                    // Re-enrich commit statuses after events that change HEAD
                    // (pull, restore, merge) — NOT on every 'Synced' poll tick
                    if (status === 'watching' && commitHistory.length > 0 &&
                        (message.includes('Pulled') || message.includes('restored') || message.includes('merged'))) {
                        scheduleEnrichment(ws);
                    }
                },
                onPushSuccess: async () => {
                    // Delay to let Overleaf process the pushed content
                    if (poller?.isRunning) {
                        outputChannel.appendLine('[PDF] Waiting 5s for Overleaf to process push...');
                        sidebar.setPdfState('running', 'Waiting for Overleaf...');
                        updatePdfStatusBar('Waiting for Overleaf...');
                        await new Promise(r => setTimeout(r, 5000));
                        poller?.triggerOnce();
                    }
                },
                onError: (message) => {
                    vscode.window.showErrorMessage(`Overleaf GitLive: ${message}`);
                    updateSyncStatusBar('error', message);
                    sidebar.setSyncStatus('error', message);
                },
                onConflict: (conflictingFiles, _details, diffSummary, localAhead, remoteBehind) => {
                    // Update sidebar with full conflict info and resolution buttons
                    sidebar.setConflictInfo(conflictingFiles, diffSummary, localAhead, remoteBehind);
                },
                onMergeComplete: (mergedFiles) => {
                    // Scan for conflict markers after merge
                    conflictScanner.scanFiles(ws, mergedFiles).then(count => {
                        if (count > 0) {
                            conflictScanner.startWatching(ws, mergedFiles);
                            outputChannel.appendLine(`[Conflict] Found ${count} conflict marker(s). Resolve them to continue sync.`);
                            vscode.window.showWarningMessage(
                                `Overleaf GitLive: ${count} conflict marker(s) found. Resolve them and save to auto-resume sync.`,
                            );
                        }
                    });
                },
                onCommitSuccess: (entry) => {
                    commitHistory.unshift(entry);
                    if (commitHistory.length > MAX_COMMIT_HISTORY) {
                        commitHistory.length = MAX_COMMIT_HISTORY;
                    }
                    scheduleEnrichment(ws);
                },
            }, outputChannel);

            await syncEngine.start();
        }),
    );

    // ── Stop Sync ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.stopSync', () => {
            syncEngine?.stop();
            syncEngine = undefined;
            updateSyncStatusBar('idle', 'Sync stopped');
            sidebar.setSyncStatus('idle', 'Not started');
            sidebar.clearConflict();
            setTimeout(() => syncStatusBar?.hide(), 2000);
        }),
    );

    // ── Conflict Resolution Commands (triggered from sidebar) ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.resolveConflict.pull', async () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitLive: No conflict to resolve.');
                return;
            }
            await syncEngine.resolveWithPull();
        }),
        vscode.commands.registerCommand('overleaf-gitlive.resolveConflict.forcePush', async () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitLive: No conflict to resolve.');
                return;
            }
            await syncEngine.resolveWithForcePush();
        }),
        vscode.commands.registerCommand('overleaf-gitlive.resolveConflict.diff', () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitLive: No conflict to resolve.');
                return;
            }
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws) {
                openInteractiveMerge(ws, syncEngine.conflictFiles, 'origin', 'master', outputChannel);
                // Enable auto-detection so checkConflictResolved() starts scanning
                syncEngine.notifyMergeActionTaken();
            }
        }),
        vscode.commands.registerCommand('overleaf-gitlive.resolveConflict.markResolved', async () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitLive: No conflict to resolve.');
                return;
            }
            await syncEngine.markResolved();
        }),
        vscode.commands.registerCommand('overleaf-gitlive.resolveConflict.terminal', () => {
            if (!syncEngine) { return; }
            syncEngine.openTerminal();
        }),
    );

    // ── Start PDF Preview ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.startPdfPreview', async () => {
            if (poller?.isRunning) {
                vscode.window.showInformationMessage('Overleaf GitLive: PDF preview is already running.');
                return;
            }

            const creds = await collectCredentials();
            if (!creds) {
                vscode.window.showWarningMessage('Overleaf GitLive: Cancelled — credentials incomplete.');
                return;
            }

            // Try to auto-detect project ID from git remote
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            let projectId: string | undefined;
            let projectName = 'Overleaf';

            if (ws) {
                const remoteUrl = await getRemoteUrl(ws);
                if (remoteUrl) {
                    projectId = extractProjectIdFromUrl(remoteUrl);
                }
            }

            if (!projectId) {
                const project = await pickProject(creds);
                if (!project) { return; }
                projectId = project.id;
                projectName = project.name;
            }

            const rootDocInput = await promptInput('Root document path (Enter for default)', 'main.tex');
            if (rootDocInput === undefined) { return; }
            const rootDoc = rootDocInput || 'main.tex';

            const identity: Identity = { ...creds, projectId, rootResourcePath: rootDoc };

            // Create session manager for auto cookie/CSRF refresh
            sessionManager = new SessionManager(identity, authStore, (msg) => {
                outputChannel.appendLine(msg);
            });

            const outputDir = await getOutputDir();
            if (!outputDir) { return; }
            const safeName = projectName.replace(/[^a-zA-Z0-9_\-]/g, '_');
            outputPdfPath = path.join(outputDir, `${safeName}.pdf`);

            const pdfPollMs = getConfig<number>('pdfPollSeconds', 0) * 1000;

            poller = new PdfPoller(
                identity,
                pdfPollMs,
                async (pdfBuffer, _buildId) => {
                    await savePdfAndOpen(pdfBuffer, outputPdfPath!);
                    sidebar.setPdfState('running', 'PDF updated');
                },
                (errMsg) => {
                    vscode.window.showErrorMessage(`Overleaf GitLive: ${errMsg}`);
                    updatePdfStatusBar('Error');
                    sidebar.setPdfState('error', errMsg);
                },
                (statusMsg) => {
                    updatePdfStatusBar(statusMsg);
                    sidebar.setPdfState('running', statusMsg);
                },
                sessionManager,
            );
            poller.start();
        }),
    );

    // ── Stop PDF Preview ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.stopPdfPreview', () => {
            poller?.stop();
            poller = undefined;
            updatePdfStatusBar('Stopped');
            sidebar.setPdfState('stopped', 'Not started');
            setTimeout(() => pdfStatusBar?.hide(), 2000);
        }),
    );

    // ── Refresh PDF (manual one-shot) ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.refreshPdf', () => {
            if (poller?.isRunning) {
                poller.triggerOnce();
            } else {
                vscode.window.showWarningMessage('Overleaf GitLive: Start PDF preview first.');
            }
        }),
    );

    // ── View Commit Diff (QuickPick or triggered from sidebar) ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.viewCommitDiff', async () => {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!ws) {
                vscode.window.showErrorMessage('Overleaf GitLive: No workspace folder open.');
                return;
            }

            const mode = getConfig<string>('diffViewMode', 'sidebar');
            if (mode === 'sidebar') {
                // Just reveal the sidebar — user interacts with the commit list there
                await vscode.commands.executeCommand('overleaf-gitlive.sidebar.focus');
                return;
            }

            // QuickPick mode
            if (commitHistory.length === 0) {
                vscode.window.showInformationMessage('Overleaf GitLive: No commits yet. Start sync first.');
                return;
            }

            const items = commitHistory.map(c => ({
                label: `${c.timestamp} · ${c.sha}`,
                description: `${c.filesChanged} file(s)`,
                detail: c.summary,
                sha: c.sha,
                picked: false,
            }));

            const picked = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: 'Select commits to view aggregated diff (first & last define the range)',
                ignoreFocusOut: true,
            });

            if (!picked || picked.length === 0) { return; }

            // Use the full commit list order to determine the range
            const selectedShas = new Set(picked.map(p => p.sha));
            const indices = commitHistory
                .map((c, i) => selectedShas.has(c.sha) ? i : -1)
                .filter(i => i >= 0);
            const oldest = commitHistory[Math.max(...indices)];
            const newest = commitHistory[Math.min(...indices)];

            await openRangeDiff(ws, oldest.sha, newest.sha);
        }),
    );

    // ── Show Output ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.showOutput', () => {
            outputChannel.show();
        }),
    );

    // ── Open Settings ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitlive.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'overleaf-gitlive');
        }),
    );

    // ── Auto-start if workspace is an Overleaf project ──
    detectOverleafProject().then(async isOverleaf => {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let projectName = '';
        if (ws) {
            const remoteUrl = await getRemoteUrl(ws);
            if (remoteUrl) {
                const id = extractProjectIdFromUrl(remoteUrl);
                projectName = id ? `Project ${id.slice(0, 8)}...` : '';
            }
        }
        sidebar.setProject(isOverleaf, projectName);

        if (isOverleaf) {
            const autoStart = getConfig<string>('autoStart', 'off');
            if (autoStart === 'sync') {
                vscode.commands.executeCommand('overleaf-gitlive.startSync');
            } else if (autoStart === 'ask') {
                vscode.window.showInformationMessage(
                    'Overleaf GitLive: Overleaf project detected.',
                    'Start Sync',
                    'Start PDF Preview',
                ).then(choice => {
                    if (choice === 'Start Sync') {
                        vscode.commands.executeCommand('overleaf-gitlive.startSync');
                    } else if (choice === 'Start PDF Preview') {
                        vscode.commands.executeCommand('overleaf-gitlive.startPdfPreview');
                    }
                });
            }
            // autoStart === 'off': do nothing
        }
    });
}

async function refreshSidebarCredentials(): Promise<void> {
    const hasToken = !!(await authStore.getToken());
    const hasCookie = !!(await authStore.getCookie());
    sidebar.setCredentials(hasToken, hasCookie);
}

function scheduleEnrichment(repoPath: string): void {
    if (enrichTimer) { clearTimeout(enrichTimer); }
    enrichTimer = setTimeout(() => {
        enrichCommitStatuses(repoPath).then(() => {
            sidebar.setCommitHistory(commitHistory);
        });
    }, 300);
}

const DIFF_IGNORE_WHITESPACE_ARGS = ['--ignore-cr-at-eol', '--ignore-space-at-eol', '--ignore-blank-lines'];

async function getMeaningfulChangedFiles(repoPath: string, fromRef: string, toRef: string): Promise<string[] | undefined> {
    try {
        const nameOnly = (await execGit(repoPath, ['diff', '--name-only', ...DIFF_IGNORE_WHITESPACE_ARGS, fromRef, toRef])).trim();
        return nameOnly ? nameOnly.split(/\r?\n/) : [];
    } catch {
        return undefined;
    }
}

/**
 * Classify each commit in commitHistory using git-blame (line-level accuracy):
 * - 'orphaned': SHA not reachable from HEAD (e.g. after Overleaf restore)
 * - 'current': all added lines from this commit still survive in HEAD
 * - 'partial': only part of this commit's added lines survive in HEAD
 * - 'superseded': none of this commit's added lines survive in HEAD
 *
 * For commits with no numeric add-line stats (deletion-only/binary edge cases),
 * fallback to file-level blame survival.
 */
async function enrichCommitStatuses(repoPath: string): Promise<void> {
    if (commitHistory.length === 0) { return; }

    // Collect all unique files across all commits
    const allFiles = new Set<string>();
    for (const entry of commitHistory) {
        for (const f of entry.files) { allFiles.add(f); }
    }

    // For each file, run git blame once and collect surviving line counts by full SHA.
    const fileBlameLineCounts = new Map<string, Map<string, number>>();
    for (const file of allFiles) {
        try {
            const blame = await execGit(repoPath, ['blame', '--porcelain', 'HEAD', '--', file]);
            const lineCounts = new Map<string, number>();
            for (const line of blame.split(/\r?\n/)) {
                // Porcelain format: each hunk starts with "<40-char-sha> <orig> <final> [<count>]"
                const m = line.match(/^([0-9a-f]{40})\s+\d+\s+\d+(?:\s+(\d+))?/);
                if (m) {
                    const count = m[2] ? Number(m[2]) : 1;
                    lineCounts.set(m[1], (lineCounts.get(m[1]) || 0) + count);
                }
            }
            fileBlameLineCounts.set(file, lineCounts);
        } catch { /* file deleted or binary — skip */ }
    }

    // Classify each commit
    for (const entry of commitHistory) {
        // Whitespace/newline-only commit: keep as current, avoid noisy orphaned/superseded.
        const meaningfulChangedFiles = await getMeaningfulChangedFiles(repoPath, `${entry.sha}~1`, entry.sha);
        if (meaningfulChangedFiles && meaningfulChangedFiles.length === 0) {
            entry.status = 'current';
            continue;
        }

        // 1) Check if reachable from HEAD
        let isAncestor = true;
        try {
            await execGit(repoPath, ['merge-base', '--is-ancestor', entry.sha, 'HEAD']);
        } catch {
            isAncestor = false;
        }

        // Resolve to full SHA when possible (avoids short-SHA prefix collisions).
        let entryFullSha = '';
        try {
            entryFullSha = (await execGit(repoPath, ['rev-parse', entry.sha])).trim();
        } catch { /* fallback to short prefix match */ }
        const matchesEntrySha = (fullSha: string): boolean => {
            if (entryFullSha.length === 40) { return fullSha === entryFullSha; }
            return fullSha.startsWith(entry.sha);
        };

        // Gather per-file add-line stats for this commit.
        const addedLinesByFile = new Map<string, number>();
        try {
            const numstat = (await execGit(repoPath, ['diff', '--numstat', `${entry.sha}~1`, entry.sha])).trim();
            for (const line of numstat.split(/\r?\n/)) {
                const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
                if (m) {
                    const added = m[1] === '-' ? 0 : Number(m[1]);
                    addedLinesByFile.set(m[3], Number.isFinite(added) ? added : 0);
                }
            }
        } catch { /* fallback to file-level classification below */ }

        // 2) Check survival in HEAD by git-blame attribution.
        let touchedFileCount = 0;
        let survivingFileCount = 0;
        let totalAddedLines = 0;
        let survivingAddedLines = 0;
        for (const file of entry.files) {
            touchedFileCount++;
            const lineCounts = fileBlameLineCounts.get(file);
            let survivedLinesInFile = 0;
            if (lineCounts) {
                for (const [fullSha, count] of lineCounts) {
                    if (matchesEntrySha(fullSha)) {
                        survivedLinesInFile += count;
                    }
                }
            }

            if (survivedLinesInFile > 0) {
                survivingFileCount++;
            }

            const addedLines = addedLinesByFile.get(file) || 0;
            if (addedLines > 0) {
                totalAddedLines += addedLines;
                survivingAddedLines += Math.min(survivedLinesInFile, addedLines);
            }
        }

        // Prefer line-level classification when we have add-line stats.
        if (totalAddedLines > 0) {
            if (survivingAddedLines === 0) {
                entry.status = isAncestor ? 'superseded' : 'orphaned';
            } else if (survivingAddedLines >= totalAddedLines) {
                entry.status = 'current';
            } else {
                entry.status = 'partial';
            }
            continue;
        }

        // Fallback for deletion-only / binary edge cases.
        if (survivingFileCount === 0) {
            entry.status = isAncestor ? 'superseded' : 'orphaned';
        } else if (survivingFileCount === touchedFileCount) {
            entry.status = 'current';
        } else {
            entry.status = 'partial';
        }
    }
}

function collectAddedLineNumbersFromPatch(diffPatch: string): Set<number> {
    const added = new Set<number>();
    let newLine = 0;

    for (const line of diffPatch.split(/\r?\n/)) {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            newLine = Number(hunk[2]);
            continue;
        }

        if (
            line.startsWith('diff --git') ||
            line.startsWith('index ') ||
            line.startsWith('---') ||
            line.startsWith('+++')
        ) {
            continue;
        }

        if (line.startsWith('+')) {
            added.add(newLine);
            newLine++;
            continue;
        }

        if (line.startsWith(' ')) {
            newLine++;
        }
    }

    return added;
}

function collectSurvivingOrigLinesFromBlame(blameText: string, commitFullSha: string): Set<number> {
    const surviving = new Set<number>();

    for (const line of blameText.split(/\r?\n/)) {
        const m = line.match(/^([0-9a-f]{40})\s+(\d+)\s+\d+(?:\s+(\d+))?$/);
        if (!m || m[1] !== commitFullSha) { continue; }

        const origStart = Number(m[2]);
        const count = m[3] ? Number(m[3]) : 1;
        for (let i = 0; i < count; i++) {
            surviving.add(origStart + i);
        }
    }

    return surviving;
}

async function annotatePartialCommitFileContent(
    repoPath: string,
    baseRef: string,
    commitSha: string,
    commitFullSha: string,
    file: string,
    commitContent: string,
): Promise<{ content: string; overwrittenCount: number; addedCount: number }> {
    if (commitFullSha.length !== 40) {
        return { content: commitContent, overwrittenCount: 0, addedCount: 0 };
    }

    try {
        const patch = await execGit(repoPath, ['diff', '--unified=0', baseRef, commitSha, '--', file]);
        const addedLineNumbers = collectAddedLineNumbersFromPatch(patch);
        const addedCount = addedLineNumbers.size;
        if (addedLineNumbers.size === 0) {
            return { content: commitContent, overwrittenCount: 0, addedCount };
        }

        const blame = await execGit(repoPath, ['blame', '--line-porcelain', 'HEAD', '--', file]);
        const survivingOrigLines = collectSurvivingOrigLinesFromBlame(blame, commitFullSha);
        if (survivingOrigLines.size === 0) {
            // Keep going: this means all added lines are overwritten.
        }

        const eol = commitContent.includes('\r\n') ? '\r\n' : '\n';
        const lines = commitContent.split(/\r?\n/);
        let overwrittenCount = 0;

        for (const lineNo of addedLineNumbers) {
            if (survivingOrigLines.has(lineNo)) { continue; }

            const idx = lineNo - 1;
            if (idx < 0 || idx >= lines.length) { continue; }

            lines[idx] = `[OVERWRITTEN LATER] ${lines[idx]}`;
            overwrittenCount++;
        }

        if (overwrittenCount === 0) {
            return { content: commitContent, overwrittenCount: 0, addedCount };
        }

        return {
            content: lines.join(eol),
            overwrittenCount,
            addedCount,
        };
    } catch {
        return { content: commitContent, overwrittenCount: 0, addedCount: 0 };
    }
}

async function openRangeDiff(repoPath: string, fromSha: string, toSha: string): Promise<void> {
    const tmpDir = path.join(os.tmpdir(), 'overleaf-gitlive-diff');
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Determine the base ref for the diff
    let baseRef = `${fromSha}~1`;
    let changedFiles: string[];
    try {
        const nameOnly = (await execGit(repoPath, ['diff', '--name-only', baseRef, toSha])).trim();
        changedFiles = nameOnly ? nameOnly.split(/\r?\n/) : [];
    } catch {
        baseRef = fromSha;
        try {
            const nameOnly = (await execGit(repoPath, ['diff', '--name-only', baseRef, toSha])).trim();
            changedFiles = nameOnly ? nameOnly.split(/\r?\n/) : [];
        } catch (err: any) {
            vscode.window.showErrorMessage(`Overleaf GitLive: Could not get diff — ${err.message}`);
            return;
        }
    }

    const rawChangedCount = changedFiles.length;
    const meaningfulChanged = await getMeaningfulChangedFiles(repoPath, baseRef, toSha);
    if (meaningfulChanged) {
        changedFiles = meaningfulChanged;
    }

    if (changedFiles.length === 0) {
        if (rawChangedCount > 0 && meaningfulChanged && meaningfulChanged.length === 0) {
            vscode.window.showInformationMessage(
                'Overleaf GitLive: Only whitespace/newline changes found (ignored).',
            );
        } else {
            vscode.window.showInformationMessage('Overleaf GitLive: No file changes in selected range.');
        }
        return;
    }

    // Gather per-file stats (additions, deletions, status) for the QuickPick
    const fileStats = new Map<string, { added: string; deleted: string; status: string }>();
    try {
        const numstat = (await execGit(repoPath, ['diff', '--numstat', baseRef, toSha])).trim();
        for (const line of numstat.split(/\r?\n/)) {
            const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
            if (m) { fileStats.set(m[3], { added: m[1], deleted: m[2], status: 'M' }); }
        }
    } catch { /* stats are optional, continue without them */ }
    try {
        const nameStatus = (await execGit(repoPath, ['diff', '--name-status', baseRef, toSha])).trim();
        for (const line of nameStatus.split(/\r?\n/)) {
            const m = line.match(/^([ADMR])\t(.+)$/);
            if (m) {
                const existing = fileStats.get(m[2]);
                if (existing) { existing.status = m[1]; } else { fileStats.set(m[2], { added: '?', deleted: '?', status: m[1] }); }
            }
        }
    } catch { /* optional */ }

    // If multiple files, let the user pick which ones to view
    let filesToOpen = changedFiles;
    if (changedFiles.length > 1) {
        const statusIcons: Record<string, string> = { A: '$(diff-added)', D: '$(diff-removed)', M: '$(diff-modified)', R: '$(diff-renamed)' };
        const items = changedFiles.map(file => {
            const stat = fileStats.get(file);
            const statusChar = stat?.status || 'M';
            const icon = statusIcons[statusChar] || '$(file)';
            const additions = stat && stat.added !== '?' ? `+${stat.added}` : '';
            const deletions = stat && stat.deleted !== '?' ? `-${stat.deleted}` : '';
            const lineInfo = [additions, deletions].filter(Boolean).join(' / ');
            return {
                label: `${icon}  ${file}`,
                description: lineInfo,
                detail: statusChar === 'A' ? 'New file' : statusChar === 'D' ? 'Deleted' : statusChar === 'R' ? 'Renamed' : 'Modified',
                file,
                picked: true,
            };
        });

        const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: `${changedFiles.length} file(s) changed in ${fromSha}..${toSha} — select files to diff`,
            ignoreFocusOut: true,
        });

        if (!picked || picked.length === 0) { return; }
        filesToOpen = picked.map(p => p.file);
    }

    const isSingleCommit = fromSha === toSha;
    let singleCommitFullSha = '';
    if (isSingleCommit) {
        try {
            singleCommitFullSha = (await execGit(repoPath, ['rev-parse', toSha])).trim();
        } catch { /* best-effort */ }
    }

    let opened = 0;
    let markedFileCount = 0;
    let markedLineCount = 0;
    for (const file of filesToOpen) {
        try {
            // Get old version
            let oldContent: string;
            try {
                oldContent = await execGit(repoPath, ['show', `${baseRef}:${file}`]);
            } catch {
                oldContent = ''; // file didn't exist before
            }

            // Get new version: use working tree if toSha is HEAD, otherwise git show
            let newUri: vscode.Uri;
            let title = `${file}: ${fromSha} ↔ ${toSha}`;
            const headSha = (await execGit(repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
            if (toSha === headSha || toSha === 'HEAD') {
                const localPath = path.join(repoPath, file);
                if (fs.existsSync(localPath)) {
                    newUri = vscode.Uri.file(localPath);
                } else {
                    continue;
                }
            } else {
                let newContent = await execGit(repoPath, ['show', `${toSha}:${file}`]);

                if (isSingleCommit && singleCommitFullSha.length === 40) {
                    const annotated = await annotatePartialCommitFileContent(
                        repoPath,
                        baseRef,
                        toSha,
                        singleCommitFullSha,
                        file,
                        newContent,
                    );
                    if (annotated.overwrittenCount > 0) {
                        newContent = annotated.content;
                        markedFileCount++;
                        markedLineCount += annotated.overwrittenCount;
                        const overwriteTag = annotated.addedCount > 0 && annotated.overwrittenCount >= annotated.addedCount
                            ? 'overwritten'
                            : 'partial';
                        title = `${file}: ${fromSha} ↔ ${toSha} [${overwriteTag}, ${annotated.overwrittenCount} overwritten]`;
                    }
                }

                const safeName = file.replace(/[/\\]/g, '__');
                const newTmp = path.join(tmpDir, `new_${toSha}_${safeName}`);
                fs.writeFileSync(newTmp, newContent, 'utf-8');
                newUri = vscode.Uri.file(newTmp);
            }

            // Write old version to temp
            const safeName = file.replace(/[/\\]/g, '__');
            const oldTmp = path.join(tmpDir, `old_${fromSha}_${safeName}`);
            fs.writeFileSync(oldTmp, oldContent, 'utf-8');
            const oldUri = vscode.Uri.file(oldTmp);

            await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, { preview: false });
            opened++;
        } catch (err: any) {
            outputChannel.appendLine(`[Diff] Could not open diff for ${file}: ${err.message}`);
        }
    }

    if (opened > 0) {
        const markerSuffix = markedFileCount > 0
            ? ` Marked ${markedLineCount} overwritten added line(s) in ${markedFileCount} file(s).`
            : '';
        vscode.window.showInformationMessage(
            `Overleaf GitLive: Opened ${opened} diff(s) for range ${fromSha}..${toSha}.${markerSuffix}`,
        );
    }
}

export function deactivate() {
    syncEngine?.stop();
    poller?.stop();
    syncStatusBar?.dispose();
    pdfStatusBar?.dispose();
    outputChannel?.dispose();
}
