import * as vscode from 'vscode';
import { SyncStatus } from './gitSync';

export type PdfState = 'stopped' | 'running' | 'error';

interface SidebarState {
    hasToken: boolean;
    hasCookie: boolean;
    isOverleafProject: boolean;
    projectName: string;
    syncStatus: SyncStatus;
    syncMessage: string;
    pdfState: PdfState;
    pdfMessage: string;
    conflictFiles: string[];
    conflictDiffSummary: string;
    conflictLocalAhead: number;
    conflictRemoteBehind: number;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'overleaf-gitbridge.sidebar';

    private _view?: vscode.WebviewView;

    private state: SidebarState = {
        hasToken: false,
        hasCookie: false,
        isOverleafProject: false,
        projectName: '',
        syncStatus: 'idle',
        syncMessage: 'Not started',
        pdfState: 'stopped',
        pdfMessage: 'Not started',
        conflictFiles: [],
        conflictDiffSummary: '',
        conflictLocalAhead: 0,
        conflictRemoteBehind: 0,
    };

    constructor(private readonly _extensionUri: vscode.Uri) { }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.command) {
                vscode.commands.executeCommand(msg.command);
            }
        });

        this._updateHtml();
    }

    // ── State setters ──

    setCredentials(hasToken: boolean, hasCookie: boolean): void {
        this.state.hasToken = hasToken;
        this.state.hasCookie = hasCookie;
        this._updateHtml();
    }

    setProject(isOverleaf: boolean, name: string): void {
        this.state.isOverleafProject = isOverleaf;
        this.state.projectName = name;
        this._updateHtml();
    }

    setSyncStatus(status: SyncStatus, message: string): void {
        this.state.syncStatus = status;
        this.state.syncMessage = message;
        this._updateHtml();
    }

    setPdfState(pdfState: PdfState, message: string): void {
        this.state.pdfState = pdfState;
        this.state.pdfMessage = message;
        this._updateHtml();
    }

    setConflictFiles(files: string[]): void {
        this.state.conflictFiles = files;
        this._updateHtml();
    }

    setConflictInfo(files: string[], diffSummary: string, localAhead: number, remoteBehind: number): void {
        this.state.conflictFiles = files;
        this.state.conflictDiffSummary = diffSummary;
        this.state.conflictLocalAhead = localAhead;
        this.state.conflictRemoteBehind = remoteBehind;
        this._updateHtml();
    }

    clearConflict(): void {
        this.state.conflictFiles = [];
        this.state.conflictDiffSummary = '';
        this.state.conflictLocalAhead = 0;
        this.state.conflictRemoteBehind = 0;
        this._updateHtml();
    }

    private _updateHtml(): void {
        if (!this._view) { return; }
        this._view.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const s = this.state;

        const tokenIcon = s.hasToken ? '✅' : '❌';
        const cookieIcon = s.hasCookie ? '✅' : '❌';

        const syncIconMap: Record<SyncStatus, string> = {
            idle: '⏹',
            watching: '👁',
            committing: '📝',
            pushing: '⬆️',
            pulling: '⬇️',
            conflict: '⚠️',
            error: '🔴',
        };
        const syncIcon = syncIconMap[s.syncStatus] || '⏹';

        const syncColorMap: Record<SyncStatus, string> = {
            idle: 'var(--vscode-descriptionForeground)',
            watching: 'var(--vscode-charts-green)',
            committing: 'var(--vscode-charts-blue)',
            pushing: 'var(--vscode-charts-blue)',
            pulling: 'var(--vscode-charts-blue)',
            conflict: 'var(--vscode-charts-orange)',
            error: 'var(--vscode-charts-red)',
        };
        const syncColor = syncColorMap[s.syncStatus] || 'inherit';

        const pdfIcon = s.pdfState === 'running' ? '🟢' : s.pdfState === 'error' ? '🔴' : '⏹';
        const pdfColor = s.pdfState === 'running' ? 'var(--vscode-charts-green)' :
            s.pdfState === 'error' ? 'var(--vscode-charts-red)' :
                'var(--vscode-descriptionForeground)';

        const syncButtons = s.syncStatus === 'idle'
            ? `<button class="btn btn-primary" onclick="cmd('overleaf-gitbridge.startSync')">▶  Start Sync</button>`
            : `<button class="btn btn-danger" onclick="cmd('overleaf-gitbridge.stopSync')">⏹  Stop Sync</button>`;

        const pdfButtons = s.pdfState === 'stopped'
            ? `<button class="btn btn-primary" onclick="cmd('overleaf-gitbridge.startPdfPreview')">▶  Start PDF Preview</button>`
            : `<div class="btn-row">
                <button class="btn btn-danger" onclick="cmd('overleaf-gitbridge.stopPdfPreview')">⏹  Stop</button>
                <button class="btn btn-secondary" onclick="cmd('overleaf-gitbridge.refreshPdf')">🔄  Refresh</button>
               </div>`;

        const projectSection = s.isOverleafProject
            ? `<div class="status-row">
                <span class="status-icon">✅</span>
                <span class="status-text">${this._esc(s.projectName || 'Overleaf Project')}</span>
               </div>`
            : `<div class="status-row">
                <span class="status-icon">ℹ️</span>
                <span class="status-text dim">No Overleaf project detected</span>
               </div>
               <button class="btn btn-primary" onclick="cmd('overleaf-gitbridge.cloneProject')">📥  Clone Project</button>`;

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, sans-serif);
        font-size: 13px;
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        padding: 12px 14px;
        line-height: 1.6;
    }
    .section {
        margin-bottom: 18px;
    }
    .section-title {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, rgba(128,128,128,0.3)));
        padding-bottom: 5px;
        margin-bottom: 10px;
    }
    .cred-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        cursor: pointer;
        border-radius: 4px;
        padding-left: 4px;
    }
    .cred-row:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .cred-label { font-size: 13px; }
    .status-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 4px;
        border-radius: 4px;
    }
    .status-icon { font-size: 16px; flex-shrink: 0; }
    .status-text { font-size: 13px; font-weight: 500; }
    .status-text.dim { color: var(--vscode-descriptionForeground); }
    .sync-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        margin: 4px 0;
    }
    .btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        padding: 8px 12px;
        margin-top: 6px;
        border: none;
        border-radius: 4px;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        gap: 6px;
        transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn:active { opacity: 0.7; }
    .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .btn-danger {
        background: var(--vscode-inputValidation-errorBackground, #c53030);
        color: var(--vscode-inputValidation-errorForeground, #fff);
        border: 1px solid var(--vscode-inputValidation-errorBorder, #c53030);
    }
    .btn-success {
        background: #2ea043;
        color: #fff;
        border: 1px solid #2ea043;
    }
    .btn-success:hover {
        background: #3fb950;
    }
    .btn-row {
        display: flex;
        gap: 6px;
    }
    .btn-row .btn { flex: 1; }
    .link-btn {
        background: none;
        border: none;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
        padding: 4px 0;
        text-decoration: underline;
    }
    .link-btn:hover { color: var(--vscode-textLink-activeForeground); }
    .divider {
        height: 1px;
        background: var(--vscode-widget-border, rgba(128,128,128,0.2));
        margin: 6px 0;
    }
    .conflict-file-list {
        list-style: none;
        padding: 0;
        margin: 6px 0;
    }
    .conflict-file-list li {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 4px;
        font-size: 12px;
        color: var(--vscode-charts-orange);
    }
    .conflict-file-list li:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .conflict-hint {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin: 4px 0 8px;
        line-height: 1.5;
    }
    .conflict-panel {
        background: var(--vscode-inputValidation-warningBackground, rgba(255,204,0,0.08));
        border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,204,0,0.4));
        border-radius: 6px;
        padding: 12px;
    }
    .conflict-summary {
        font-size: 12px;
        margin: 6px 0;
        line-height: 1.5;
    }
    .conflict-details {
        margin: 6px 0;
        font-size: 11px;
    }
    .conflict-details summary {
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
        font-size: 12px;
        margin-bottom: 4px;
    }
    .conflict-log {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
        border-radius: 4px;
        padding: 6px 8px;
        max-height: 120px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
    }
    .conflict-section-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        margin-top: 8px;
        margin-bottom: 2px;
    }
</style>
</head>
<body>

    <!-- Credentials -->
    <div class="section">
        <div class="section-title">🔑 Credentials</div>
        <div class="cred-row" onclick="cmd('overleaf-gitbridge.configureToken')">
            <span>${tokenIcon}</span>
            <span class="cred-label">Git Token: ${s.hasToken ? 'Configured' : '<b>Not set</b>'}</span>
        </div>
        <div class="cred-row" onclick="cmd('overleaf-gitbridge.configureCookie')">
            <span>${cookieIcon}</span>
            <span class="cred-label">Cookie: ${s.hasCookie ? 'Configured' : '<b>Not set</b>'}</span>
        </div>
        <button class="link-btn" onclick="cmd('overleaf-gitbridge.clearCredentials')">Clear all credentials</button>
    </div>

    <!-- Project -->
    <div class="section">
        <div class="section-title">📁 Project</div>
        ${projectSection}
    </div>

    <!-- Git Sync -->
    <div class="section">
        <div class="section-title">🔄 Git Sync</div>
        <div class="sync-badge" style="color: ${syncColor};">
            <span style="font-size:16px;">${syncIcon}</span>
            <span>${this._esc(s.syncMessage)}</span>
        </div>
        ${syncButtons}
    </div>

    ${s.syncStatus === 'conflict' && s.conflictFiles.length > 0 ? `
    <!-- Conflict Resolution Panel -->
    <div class="section conflict-panel">
        <div class="section-title">⚠️ Conflict Detected</div>
        <p class="conflict-summary">
            Remote has <b>${s.conflictRemoteBehind}</b> new commit(s), you have <b>${s.conflictLocalAhead}</b> local commit(s).
        </p>
        ${s.conflictDiffSummary ? `
        <details class="conflict-details">
            <summary>Remote commits</summary>
            <pre class="conflict-log">${this._esc(s.conflictDiffSummary)}</pre>
        </details>` : ''}
        <div class="conflict-section-label">Affected files:</div>
        <ul class="conflict-file-list">
            ${s.conflictFiles.map(f => `<li>📄 ${this._esc(f)}</li>`).join('')}
        </ul>
        <div class="conflict-section-label">Choose a resolution:</div>
        <button class="btn btn-primary" onclick="cmd('overleaf-gitbridge.resolveConflict.pull')">⬇️  Pull &amp; Merge</button>
        <button class="btn btn-secondary" onclick="cmd('overleaf-gitbridge.resolveConflict.diff')">✏️  Merge in Editor</button>
        <button class="btn btn-success" onclick="cmd('overleaf-gitbridge.resolveConflict.markResolved')">✅  Mark Resolved</button>
        <div class="btn-row">
            <button class="btn btn-danger" onclick="cmd('overleaf-gitbridge.resolveConflict.forcePush')">⬆️  Force Push</button>
            <button class="btn btn-secondary" onclick="cmd('overleaf-gitbridge.resolveConflict.terminal')">💻  Terminal</button>
        </div>
        <p class="conflict-hint">Resolve conflicts, then click "Mark Resolved" or save — sync will auto-commit &amp; push.</p>
    </div>` : ''}

    <!-- PDF Preview -->
    <div class="section">
        <div class="section-title">📄 PDF Preview</div>
        <div class="sync-badge" style="color: ${pdfColor};">
            <span style="font-size:16px;">${pdfIcon}</span>
            <span>${this._esc(s.pdfMessage)}</span>
        </div>
        ${pdfButtons}
    </div>

    <div class="divider"></div>
    <button class="link-btn" onclick="cmd('overleaf-gitbridge.showOutput')">📋 Show Output Log</button>
    <button class="link-btn" onclick="cmd('overleaf-gitbridge.openSettings')">⚙️ Settings (poll interval, quiet period...)</button>

<script>
    const vscode = acquireVsCodeApi();
    function cmd(command) {
        vscode.postMessage({ command });
    }
</script>
</body>
</html>`;
    }

    private _esc(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
