import * as vscode from 'vscode';

const MARKER_REGEX = /^(<{7}|={7}|>{7})\s?.*$/;

/**
 * Scans workspace files for Git conflict markers and reports them
 * as Diagnostics in the Problems panel.
 */
export class ConflictMarkerScanner {
    private _diagnostics: vscode.DiagnosticCollection;
    private _watcher: vscode.FileSystemWatcher | undefined;
    private _disposables: vscode.Disposable[] = [];

    constructor() {
        this._diagnostics = vscode.languages.createDiagnosticCollection('overleaf-conflict-markers');
    }

    /**
     * Scan the given files for conflict markers and populate Diagnostics.
     * Also navigate to the first conflict marker found.
     */
    async scanFiles(repoPath: string, files: string[]): Promise<number> {
        this._diagnostics.clear();
        let totalMarkers = 0;
        let firstLocation: { uri: vscode.Uri; range: vscode.Range } | undefined;

        for (const file of files) {
            const uri = vscode.Uri.file(`${repoPath}/${file}`);
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const diagnostics: vscode.Diagnostic[] = [];

                for (let i = 0; i < doc.lineCount; i++) {
                    const line = doc.lineAt(i);
                    if (MARKER_REGEX.test(line.text)) {
                        const range = new vscode.Range(i, 0, i, line.text.length);
                        const severity = line.text.startsWith('<<<<<<<')
                            ? vscode.DiagnosticSeverity.Error
                            : vscode.DiagnosticSeverity.Warning;
                        const msg = line.text.startsWith('<<<<<<<') ? 'Conflict start marker'
                            : line.text.startsWith('=======') ? 'Conflict separator'
                            : 'Conflict end marker';
                        const diag = new vscode.Diagnostic(range, msg, severity);
                        diag.source = 'Overleaf GitBridge';
                        diagnostics.push(diag);
                        totalMarkers++;

                        if (!firstLocation) {
                            firstLocation = { uri, range };
                        }
                    }
                }

                if (diagnostics.length > 0) {
                    this._diagnostics.set(uri, diagnostics);
                }
            } catch { /* file may not exist */ }
        }

        // Navigate to first conflict marker
        if (firstLocation) {
            const doc = await vscode.workspace.openTextDocument(firstLocation.uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            editor.revealRange(firstLocation.range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(firstLocation.range.start, firstLocation.range.start);
        }

        return totalMarkers;
    }

    /**
     * Start watching files for changes and re-scan to update diagnostics.
     */
    startWatching(repoPath: string, files: string[]): void {
        this.stopWatching();

        // Watch for saves on the conflicting files
        for (const file of files) {
            const pattern = new vscode.RelativePattern(repoPath, file);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(() => this.rescanSingle(repoPath, file));
            this._disposables.push(watcher);
        }

        // Also re-scan on document save
        const onSave = vscode.workspace.onDidSaveTextDocument(doc => {
            const relPath = vscode.workspace.asRelativePath(doc.uri, false);
            if (files.includes(relPath)) {
                this.rescanSingle(repoPath, relPath);
            }
        });
        this._disposables.push(onSave);
    }

    private async rescanSingle(repoPath: string, file: string): Promise<void> {
        const uri = vscode.Uri.file(`${repoPath}/${file}`);
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const diagnostics: vscode.Diagnostic[] = [];

            for (let i = 0; i < doc.lineCount; i++) {
                const line = doc.lineAt(i);
                if (MARKER_REGEX.test(line.text)) {
                    const range = new vscode.Range(i, 0, i, line.text.length);
                    const severity = line.text.startsWith('<<<<<<<')
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning;
                    const msg = line.text.startsWith('<<<<<<<') ? 'Conflict start marker'
                        : line.text.startsWith('=======') ? 'Conflict separator'
                        : 'Conflict end marker';
                    const diag = new vscode.Diagnostic(range, msg, severity);
                    diag.source = 'Overleaf GitBridge';
                    diagnostics.push(diag);
                }
            }

            this._diagnostics.set(uri, diagnostics.length > 0 ? diagnostics : []);
        } catch { /* ignore */ }
    }

    /**
     * Check if any diagnostics (conflict markers) remain.
     */
    get hasConflicts(): boolean {
        let count = 0;
        this._diagnostics.forEach((_uri, diags) => {
            count += diags.length;
        });
        return count > 0;
    }

    stopWatching(): void {
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
    }

    clear(): void {
        this.stopWatching();
        this._diagnostics.clear();
    }

    dispose(): void {
        this.clear();
        this._diagnostics.dispose();
    }
}
