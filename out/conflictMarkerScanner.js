"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConflictMarkerScanner = void 0;
const vscode = __importStar(require("vscode"));
const MARKER_REGEX = /^(<{7}|={7}|>{7})\s?.*$/;
/**
 * Scans workspace files for Git conflict markers and reports them
 * as Diagnostics in the Problems panel.
 */
class ConflictMarkerScanner {
    constructor() {
        this._disposables = [];
        this._diagnostics = vscode.languages.createDiagnosticCollection('overleaf-conflict-markers');
    }
    /**
     * Scan the given files for conflict markers and populate Diagnostics.
     * Also navigate to the first conflict marker found.
     */
    async scanFiles(repoPath, files) {
        this._diagnostics.clear();
        let totalMarkers = 0;
        let firstLocation;
        for (const file of files) {
            const uri = vscode.Uri.file(`${repoPath}/${file}`);
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const diagnostics = [];
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
            }
            catch { /* file may not exist */ }
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
    startWatching(repoPath, files) {
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
    async rescanSingle(repoPath, file) {
        const uri = vscode.Uri.file(`${repoPath}/${file}`);
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const diagnostics = [];
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
        }
        catch { /* ignore */ }
    }
    /**
     * Check if any diagnostics (conflict markers) remain.
     */
    get hasConflicts() {
        let count = 0;
        this._diagnostics.forEach((_uri, diags) => {
            count += diags.length;
        });
        return count > 0;
    }
    stopWatching() {
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
    }
    clear() {
        this.stopWatching();
        this._diagnostics.clear();
    }
    dispose() {
        this.clear();
        this._diagnostics.dispose();
    }
}
exports.ConflictMarkerScanner = ConflictMarkerScanner;
//# sourceMappingURL=conflictMarkerScanner.js.map