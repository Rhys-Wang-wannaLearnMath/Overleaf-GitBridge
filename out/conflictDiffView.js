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
exports.openConflictDiffs = openConflictDiffs;
exports.openInteractiveMerge = openInteractiveMerge;
exports.cleanupDiffTmpFiles = cleanupDiffTmpFiles;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const gitUtils_1 = require("./gitUtils");
/**
 * Open VS Code diff editors for each conflicting file,
 * showing the remote (Overleaf) version vs the local version.
 */
async function openConflictDiffs(repoPath, conflictingFiles, remote, branch, outputChannel) {
    if (conflictingFiles.length === 0) {
        return;
    }
    const tmpDir = path.join(os.tmpdir(), 'overleaf-gitbridge-diff');
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
    for (const file of conflictingFiles) {
        try {
            // Get the remote version of the file
            const remoteContent = await (0, gitUtils_1.execGit)(repoPath, ['show', `${remote}/${branch}:${file}`]);
            // Write remote version to temp file
            const safeName = file.replace(/[/\\]/g, '__');
            const tmpFile = path.join(tmpDir, `remote_${safeName}`);
            fs.writeFileSync(tmpFile, remoteContent, 'utf-8');
            const remoteUri = vscode.Uri.file(tmpFile);
            const localUri = vscode.Uri.file(path.join(repoPath, file));
            const title = `${file}: Remote (Overleaf) ↔ Local`;
            await vscode.commands.executeCommand('vscode.diff', remoteUri, localUri, title);
        }
        catch (err) {
            outputChannel.appendLine(`[Diff] Could not open diff for ${file}: ${err.message}`);
        }
    }
    if (conflictingFiles.length > 0) {
        vscode.window.showInformationMessage(`Overleaf GitBridge: Opened ${conflictingFiles.length} diff editor(s) for conflicting files.`);
    }
}
/**
 * Open interactive merge for each conflicting file.
 * Uses git merge-file to inject conflict markers (<<<<<<< / ======= / >>>>>>>)
 * into the local file. VS Code automatically detects these markers and shows
 * inline "Accept Current Change | Accept Incoming Change | Accept Both Changes" buttons.
 *
 * A backup of the original local file is created in the tmp dir before modification.
 */
async function openInteractiveMerge(repoPath, conflictingFiles, remote, branch, outputChannel) {
    if (conflictingFiles.length === 0) {
        return;
    }
    // If a real git merge is in progress (MERGE_HEAD exists), the files
    // already have proper conflict markers from git. Just open them directly.
    const mergeHeadPath = path.join(repoPath, '.git', 'MERGE_HEAD');
    if (fs.existsSync(mergeHeadPath)) {
        outputChannel.appendLine('[Merge] Git merge in progress — opening files with existing markers.');
        let opened = 0;
        for (const file of conflictingFiles) {
            const fullPath = path.join(repoPath, file);
            if (fs.existsSync(fullPath)) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
                await vscode.window.showTextDocument(doc, { preview: false });
                opened++;
            }
        }
        if (opened > 0) {
            vscode.window.showInformationMessage(`Overleaf GitBridge: Opened ${opened} file(s). Use inline buttons to accept changes, then save.`);
        }
        return;
    }
    // No active git merge — use git merge-file to inject conflict markers
    const tmpDir = path.join(os.tmpdir(), 'overleaf-gitbridge-diff');
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
    // Find the common ancestor commit
    let mergeBase;
    try {
        mergeBase = (await (0, gitUtils_1.execGit)(repoPath, ['merge-base', 'HEAD', `${remote}/${branch}`])).trim();
    }
    catch {
        outputChannel.appendLine('[Merge] Could not find merge-base. Falling back to read-only diff.');
        await openConflictDiffs(repoPath, conflictingFiles, remote, branch, outputChannel);
        return;
    }
    let mergedCount = 0;
    for (const file of conflictingFiles) {
        const localFile = path.join(repoPath, file);
        const safeName = file.replace(/[/\\]/g, '__');
        try {
            // Get base version (common ancestor) and remote version
            let baseContent;
            try {
                baseContent = await (0, gitUtils_1.execGit)(repoPath, ['show', `${mergeBase}:${file}`]);
            }
            catch {
                // File didn't exist at base — use empty content
                baseContent = '';
            }
            let remoteContent;
            try {
                remoteContent = await (0, gitUtils_1.execGit)(repoPath, ['show', `${remote}/${branch}:${file}`]);
            }
            catch {
                // File doesn't exist on remote — skip
                outputChannel.appendLine(`[Merge] ${file}: not found on remote, skipping.`);
                continue;
            }
            // Backup: only create on first run; restore from backup on repeat clicks
            const backupFile = path.join(tmpDir, `backup_${safeName}`);
            if (fs.existsSync(backupFile)) {
                // Already merged before — restore the clean original first
                fs.copyFileSync(backupFile, localFile);
            }
            else if (fs.existsSync(localFile)) {
                // First time — save original as backup
                fs.copyFileSync(localFile, backupFile);
            }
            // Write base and remote to temp files for git merge-file
            const baseTmp = path.join(tmpDir, `base_${safeName}`);
            const remoteTmp = path.join(tmpDir, `remote_${safeName}`);
            fs.writeFileSync(baseTmp, baseContent, 'utf-8');
            fs.writeFileSync(remoteTmp, remoteContent, 'utf-8');
            // git merge-file modifies the first arg in-place
            // Copy the clean local to a working file, then merge, then copy back
            const workTmp = path.join(tmpDir, `work_${safeName}`);
            fs.copyFileSync(localFile, workTmp);
            try {
                // git merge-file exits 0 = clean merge, 1 = conflicts, <0 = error
                await (0, gitUtils_1.execGit)(repoPath, [
                    'merge-file',
                    '-L', 'Local (yours)',
                    '-L', 'Base',
                    '-L', 'Remote (Overleaf)',
                    workTmp, baseTmp, remoteTmp,
                ]);
                // Clean merge — no conflicts. Still write result so user sees the merged version.
            }
            catch {
                // Exit code 1 = conflicts found — this is expected and desired
            }
            // Write merged content (with conflict markers) back to local file
            fs.copyFileSync(workTmp, localFile);
            // Open in editor
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(localFile));
            await vscode.window.showTextDocument(doc, { preview: false });
            mergedCount++;
        }
        catch (err) {
            outputChannel.appendLine(`[Merge] Could not merge ${file}: ${err.message}`);
        }
    }
    if (mergedCount > 0) {
        vscode.window.showInformationMessage(`Overleaf GitBridge: Opened ${mergedCount} file(s) with conflict markers. Use the inline buttons to accept changes.`);
    }
}
/**
 * Clean up temporary diff files.
 */
function cleanupDiffTmpFiles() {
    const tmpDir = path.join(os.tmpdir(), 'overleaf-gitbridge-diff');
    try {
        if (fs.existsSync(tmpDir)) {
            const files = fs.readdirSync(tmpDir);
            for (const f of files) {
                fs.unlinkSync(path.join(tmpDir, f));
            }
        }
    }
    catch { /* ignore */ }
}
//# sourceMappingURL=conflictDiffView.js.map