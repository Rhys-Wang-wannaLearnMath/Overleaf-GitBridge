import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Credentials, Identity, loginWithCookies, fetchProjects } from './api';
import { PdfPoller } from './poller';
import { AuthStore } from './auth';
import { GitSyncEngine, SyncStatus } from './gitSync';
import { CloneManager } from './cloneManager';
import { getRemoteUrl, isOverleafRepo } from './gitUtils';
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

// ── Helpers ──

async function promptInput(prompt: string, placeHolder: string, password = false, value?: string): Promise<string | undefined> {
    return vscode.window.showInputBox({ prompt, placeHolder, password, value, ignoreFocusOut: true });
}

function getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('overleaf-gitbridge').get<T>(key, fallback);
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
        { location: vscode.ProgressLocation.Notification, title: 'Overleaf GitBridge: Logging in...' },
        () => loginWithCookies(serverUrl!, cookie!),
    );

    if (!result.success || !result.creds) {
        vscode.window.showErrorMessage(`Overleaf GitBridge: ${result.error || 'Login failed. Check your cookies.'}`);
        await authStore.saveCookie('');
        return undefined;
    }

    await authStore.saveCookie(cookie);
    vscode.window.showInformationMessage('Overleaf GitBridge: Login successful!');
    return result.creds;
}

async function pickProject(creds: Credentials): Promise<{ id: string; name: string } | undefined> {
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Overleaf GitBridge: Fetching projects...' },
        () => fetchProjects(creds),
    );

    if (!result.success || !result.projects?.length) {
        vscode.window.showErrorMessage(`Overleaf GitBridge: ${result.error || 'No projects found.'}`);
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
    outputChannel = vscode.window.createOutputChannel('Overleaf GitBridge');
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

    // Status bars
    syncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -9);
    syncStatusBar.command = 'overleaf-gitbridge.stopSync';
    context.subscriptions.push(syncStatusBar);

    pdfStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -10);
    pdfStatusBar.command = 'overleaf-gitbridge.stopPdfPreview';
    context.subscriptions.push(pdfStatusBar);

    // Initialize sidebar credential state
    refreshSidebarCredentials();

    // ── Clone Project ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.cloneProject', async () => {
            const cloneManager = new CloneManager(authStore, outputChannel);
            await cloneManager.cloneProject();
        }),
    );

    // ── Configure Token ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.configureToken', async () => {
            const token = await promptInput('Enter Overleaf Git token', 'From Account Settings → Git Integration', true);
            if (token) {
                await authStore.saveToken(token);
                vscode.window.showInformationMessage('Overleaf GitBridge: Git token saved.');
                refreshSidebarCredentials();
            }
        }),
    );

    // ── Configure Cookie ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.configureCookie', async () => {
            let cookie = await promptInput('Enter Overleaf Cookie', 'Paste overleaf_session2 value', true);
            if (cookie) {
                if (!cookie.includes('overleaf_session2=')) {
                    cookie = `overleaf_session2=${cookie}`;
                }
                await authStore.saveCookie(cookie);
                vscode.window.showInformationMessage('Overleaf GitBridge: Cookie saved.');
                refreshSidebarCredentials();
            }
        }),
    );

    // ── Clear Credentials ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.clearCredentials', async () => {
            await authStore.clearAll();
            vscode.window.showInformationMessage('Overleaf GitBridge: All credentials cleared.');
            refreshSidebarCredentials();
        }),
    );

    // ── Start Sync ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.startSync', async () => {
            if (syncEngine?.isRunning) {
                vscode.window.showInformationMessage('Overleaf GitBridge: Sync is already running.');
                return;
            }

            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!ws) {
                vscode.window.showErrorMessage('Overleaf GitBridge: No workspace folder open.');
                return;
            }

            const isOverleaf = await detectOverleafProject();
            if (!isOverleaf) {
                const action = await vscode.window.showWarningMessage(
                    'Overleaf GitBridge: This does not appear to be an Overleaf Git project.',
                    'Clone a Project',
                    'Start Anyway',
                );
                if (action === 'Clone a Project') {
                    await vscode.commands.executeCommand('overleaf-gitbridge.cloneProject');
                    return;
                }
                if (action !== 'Start Anyway') { return; }
            }

            const quietSeconds = getConfig<number>('quietSeconds', 30);
            const pollSeconds = getConfig<number>('pollSeconds', 2);

            syncEngine = new GitSyncEngine(ws, quietSeconds, pollSeconds, {
                onStatusChange: (status, message) => {
                    updateSyncStatusBar(status, message);
                    sidebar.setSyncStatus(status, message);
                    // Clean up conflict state when leaving conflict status
                    if (status !== 'conflict') {
                        conflictScanner.clear();
                        cleanupDiffTmpFiles();
                        sidebar.clearConflict();
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
                    vscode.window.showErrorMessage(`Overleaf GitBridge: ${message}`);
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
                                `Overleaf GitBridge: ${count} conflict marker(s) found. Resolve them and save to auto-resume sync.`,
                            );
                        }
                    });
                },
            }, outputChannel);

            await syncEngine.start();
        }),
    );

    // ── Stop Sync ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.stopSync', () => {
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
        vscode.commands.registerCommand('overleaf-gitbridge.resolveConflict.pull', async () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitBridge: No conflict to resolve.');
                return;
            }
            await syncEngine.resolveWithPull();
        }),
        vscode.commands.registerCommand('overleaf-gitbridge.resolveConflict.forcePush', async () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitBridge: No conflict to resolve.');
                return;
            }
            await syncEngine.resolveWithForcePush();
        }),
        vscode.commands.registerCommand('overleaf-gitbridge.resolveConflict.diff', () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitBridge: No conflict to resolve.');
                return;
            }
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws) {
                openInteractiveMerge(ws, syncEngine.conflictFiles, 'origin', 'master', outputChannel);
                // Enable auto-detection so checkConflictResolved() starts scanning
                syncEngine.notifyMergeActionTaken();
            }
        }),
        vscode.commands.registerCommand('overleaf-gitbridge.resolveConflict.markResolved', async () => {
            if (!syncEngine?.inConflict) {
                vscode.window.showInformationMessage('Overleaf GitBridge: No conflict to resolve.');
                return;
            }
            await syncEngine.markResolved();
        }),
        vscode.commands.registerCommand('overleaf-gitbridge.resolveConflict.terminal', () => {
            if (!syncEngine) { return; }
            syncEngine.openTerminal();
        }),
    );

    // ── Start PDF Preview ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.startPdfPreview', async () => {
            if (poller?.isRunning) {
                vscode.window.showInformationMessage('Overleaf GitBridge: PDF preview is already running.');
                return;
            }

            const creds = await collectCredentials();
            if (!creds) {
                vscode.window.showWarningMessage('Overleaf GitBridge: Cancelled — credentials incomplete.');
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
                    vscode.window.showErrorMessage(`Overleaf GitBridge: ${errMsg}`);
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
        vscode.commands.registerCommand('overleaf-gitbridge.stopPdfPreview', () => {
            poller?.stop();
            poller = undefined;
            updatePdfStatusBar('Stopped');
            sidebar.setPdfState('stopped', 'Not started');
            setTimeout(() => pdfStatusBar?.hide(), 2000);
        }),
    );

    // ── Refresh PDF (manual one-shot) ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.refreshPdf', () => {
            if (poller?.isRunning) {
                poller.triggerOnce();
            } else {
                vscode.window.showWarningMessage('Overleaf GitBridge: Start PDF preview first.');
            }
        }),
    );

    // ── Show Output ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.showOutput', () => {
            outputChannel.show();
        }),
    );

    // ── Open Settings ──
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-gitbridge.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'overleaf-gitbridge');
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
            vscode.window.showInformationMessage(
                'Overleaf GitBridge: Overleaf project detected.',
                'Start Sync',
                'Start PDF Preview',
            ).then(choice => {
                if (choice === 'Start Sync') {
                    vscode.commands.executeCommand('overleaf-gitbridge.startSync');
                } else if (choice === 'Start PDF Preview') {
                    vscode.commands.executeCommand('overleaf-gitbridge.startPdfPreview');
                }
            });
        }
    });
}

async function refreshSidebarCredentials(): Promise<void> {
    const hasToken = !!(await authStore.getToken());
    const hasCookie = !!(await authStore.getCookie());
    sidebar.setCredentials(hasToken, hasCookie);
}

export function deactivate() {
    syncEngine?.stop();
    poller?.stop();
    syncStatusBar?.dispose();
    pdfStatusBar?.dispose();
    outputChannel?.dispose();
}
