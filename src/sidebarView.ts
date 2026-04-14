import * as vscode from 'vscode';
import { SyncStatus, CommitEntry } from './gitSync';

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
    commits: CommitEntry[];
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
        commits: [],
    };

    private _messageHandlers: ((msg: any) => void)[] = [];

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
            // Forward all messages to registered handlers (for parameterized actions)
            for (const handler of this._messageHandlers) {
                handler(msg);
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

    onMessage(handler: (msg: any) => void): void {
        this._messageHandlers.push(handler);
    }

    setCommitHistory(commits: CommitEntry[]): void {
        this.state.commits = [...commits];
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
            : `<div class="btn-row">
                <button class="btn btn-danger" onclick="cmd('overleaf-gitbridge.stopSync')">⏹  Stop</button>
                <button class="btn btn-secondary" onclick="cmd('overleaf-gitbridge.viewCommitDiff')">📊  View Diff</button>
               </div>`;

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
    .commit-list {
        list-style: none;
        padding: 0;
        margin: 6px 0;
        max-height: 240px;
        overflow-y: auto;
    }
    .commit-item {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 5px 6px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
    }
    .commit-item:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .commit-item.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
    }
    .commit-item input[type="checkbox"] {
        margin-top: 2px;
        flex-shrink: 0;
    }
    .commit-info {
        flex: 1;
        min-width: 0;
    }
    .commit-header {
        display: flex;
        gap: 6px;
        align-items: center;
    }
    .commit-sha {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        color: var(--vscode-textLink-foreground);
    }
    .commit-time {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .commit-files {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .commit-summary {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .commit-actions {
        display: flex;
        gap: 6px;
        margin-top: 6px;
        align-items: center;
    }
    .commit-actions .btn { flex: 1; }
    .commit-sel-info {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 4px;
    }
    .commit-status {
        font-size: 10px;
        font-weight: 600;
        border-radius: 3px;
        padding: 1px 5px;
        white-space: nowrap;
    }
    .commit-status.current {
        background: rgba(46, 160, 67, 0.15);
        color: var(--vscode-charts-green, #3fb950);
    }
    .commit-status.partial {
        background: rgba(255, 193, 7, 0.15);
        color: var(--vscode-charts-orange, #d97706);
    }
    .commit-status.superseded {
        background: rgba(128, 128, 128, 0.12);
        color: var(--vscode-descriptionForeground);
    }
    .commit-status.orphaned {
        background: rgba(248, 81, 73, 0.12);
        color: var(--vscode-charts-red, #f85149);
    }
    .commit-item.orphaned {
        opacity: 0.55;
    }
    .commit-item.superseded .commit-summary {
        text-decoration: line-through;
        opacity: 0.65;
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

    <!-- Commit History -->
    ${this._renderCommitHistory()}

    <div class="divider"></div>
    <button class="link-btn" onclick="cmd('overleaf-gitbridge.showOutput')">📋 Show Output Log</button>
    <button class="link-btn" onclick="cmd('overleaf-gitbridge.openSettings')">⚙️ Settings</button>

<script>
    const vscode = acquireVsCodeApi();
    function cmd(command) {
        vscode.postMessage({ command });
    }

    // Commit history selection state
    let lastClickedIdx = -1;
    const selected = new Set();

    function toggleCommit(idx, event) {
        if (event && event.shiftKey && lastClickedIdx >= 0) {
            // Shift-click: select range
            const lo = Math.min(lastClickedIdx, idx);
            const hi = Math.max(lastClickedIdx, idx);
            for (let i = lo; i <= hi; i++) {
                selected.add(i);
            }
        } else {
            if (selected.has(idx)) {
                selected.delete(idx);
            } else {
                selected.add(idx);
            }
        }
        lastClickedIdx = idx;
        updateCommitUI();
    }

    function selectAllCommits(count) {
        for (let i = 0; i < count; i++) selected.add(i);
        updateCommitUI();
    }

    function clearAllCommits() {
        selected.clear();
        lastClickedIdx = -1;
        updateCommitUI();
    }

    function updateCommitUI() {
        document.querySelectorAll('.commit-item').forEach((el, i) => {
            const cb = el.querySelector('input[type=checkbox]');
            if (cb) cb.checked = selected.has(i);
            el.classList.toggle('selected', selected.has(i));
        });
        const info = document.getElementById('commit-sel-info');
        if (info) info.textContent = selected.size > 0 ? selected.size + ' selected' : '';
    }

    function viewSelectedDiff() {
        if (selected.size === 0) return;
        const shas = window.__commitShas || [];
        const indices = Array.from(selected).sort((a, b) => a - b);
        // indices[0] = newest (smallest index = most recent), indices[last] = oldest
        const newestSha = shas[indices[0]];
        const oldestSha = shas[indices[indices.length - 1]];
        if (newestSha && oldestSha) {
            vscode.postMessage({ type: 'viewRangeDiff', fromSha: oldestSha, toSha: newestSha });
        }
    }
</script>
</body>
</html>`;
    }

    private _renderCommitHistory(): string {
        const commits = this.state.commits;
        if (commits.length === 0) {
            return `
            <div class="section">
                <div class="section-title">📋 Commit History</div>
                <p class="conflict-hint">No commits yet. Start sync to see history.</p>
            </div>`;
        }

        const statusLabel: Record<string, string> = {
            current: '\u2705 current',
            partial: '\u26a0\ufe0f partial',
            superseded: '\u25cb overwritten',
            orphaned: '\ud83d\udc7b orphaned',
        };

        const items = commits.map((c, i) => {
            const st = c.status || 'current';
            return `
            <li class="commit-item ${st}" onclick="toggleCommit(${i}, event)">
                <input type="checkbox" tabindex="-1">
                <div class="commit-info">
                    <div class="commit-header">
                        <span class="commit-sha">${this._esc(c.sha)}</span>
                        <span class="commit-time">${this._esc(c.timestamp)}</span>
                        <span class="commit-files">${c.filesChanged} file(s)</span>
                        <span class="commit-status ${st}">${statusLabel[st] || st}</span>
                    </div>
                    <div class="commit-summary" title="${this._esc(c.summary)}">${this._esc(c.summary)}</div>
                </div>
            </li>`;
        }).join('');

        // Inject the SHA array into the webview JS scope
        const shaArray = JSON.stringify(commits.map(c => c.sha));

        return `
        <div class="section">
            <div class="section-title">📋 Commit History</div>
            <ul class="commit-list">${items}</ul>
            <div class="commit-actions">
                <button class="btn btn-secondary" onclick="selectAllCommits(${commits.length})" style="font-size:11px;padding:4px 8px;">Select All</button>
                <button class="btn btn-secondary" onclick="clearAllCommits()" style="font-size:11px;padding:4px 8px;">Clear</button>
                <button class="btn btn-primary" onclick="viewSelectedDiff()" style="font-size:11px;padding:4px 8px;">📊 View Diff</button>
            </div>
            <div id="commit-sel-info" class="commit-sel-info"></div>
            <p class="conflict-hint">Click to select commits. Shift+click for range. View aggregated diff for selection.</p>
            <script>window.__commitShas = ${shaArray};</script>
        </div>`;
    }

    private _esc(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
