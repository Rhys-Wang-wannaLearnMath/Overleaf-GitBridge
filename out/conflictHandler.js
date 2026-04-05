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
exports.detectFileConflicts = detectFileConflicts;
exports.getDiffSummary = getDiffSummary;
exports.handleConflict = handleConflict;
const vscode = __importStar(require("vscode"));
const gitUtils_1 = require("./gitUtils");
/**
 * Detect file-level conflicts between local working tree and remote.
 * Compares which files are modified locally vs remotely.
 */
async function detectFileConflicts(repoPath, remote, branch, ignorePatterns = []) {
    // Build a filter function from ignore patterns (glob-style)
    const shouldIgnore = buildIgnoreFilter(ignorePatterns);
    // Local modified/staged/untracked files
    const localTracked = await safeExecGit(repoPath, ['diff', '--name-only', 'HEAD']);
    const localStaged = await safeExecGit(repoPath, ['diff', '--name-only', '--cached']);
    const localUntracked = await safeExecGit(repoPath, ['ls-files', '--others', '--exclude-standard']);
    const localFiles = new Set([...splitLines(localTracked), ...splitLines(localStaged), ...splitLines(localUntracked)]
        .filter(f => !shouldIgnore(f)));
    // Remote changed files since common ancestor
    const remoteChanged = await safeExecGit(repoPath, ['diff', '--name-only', `HEAD...${remote}/${branch}`]);
    const remoteFiles = new Set(splitLines(remoteChanged).filter(f => !shouldIgnore(f)));
    const conflicting = [];
    const localOnly = [];
    const remoteOnly = [];
    for (const f of localFiles) {
        if (remoteFiles.has(f)) {
            conflicting.push(f);
        }
        else {
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
function buildIgnoreFilter(patterns) {
    if (patterns.length === 0) {
        return () => false;
    }
    const regexes = patterns.map(p => {
        // Convert glob to regex: * → [^/]*, ** → .*, ? → [^/]
        let re = p
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars except * and ?
            .replace(/\\\*/g, '@@STAR@@') // temp placeholder
            .replace(/@@STAR@@@@STAR@@/g, '.*') // ** → .*
            .replace(/@@STAR@@/g, '[^/]*') // * → [^/]*
            .replace(/\?/g, '[^/]');
        return new RegExp(`(^|/)${re}(/|$)`);
    });
    return (filePath) => regexes.some(re => re.test(filePath));
}
function splitLines(text) {
    return text.trim().split(/\r?\n/).filter(l => l.length > 0);
}
async function safeExecGit(cwd, args) {
    try {
        return await (0, gitUtils_1.execGit)(cwd, args);
    }
    catch {
        return '';
    }
}
async function getDiffSummary(repoPath, remote, branch) {
    try {
        const result = await (0, gitUtils_1.execGit)(repoPath, ['log', '--oneline', `HEAD..${remote}/${branch}`, '-10']);
        return result.trim() || '(no details available)';
    }
    catch {
        return '(unable to retrieve diff)';
    }
}
async function handleConflict(info, outputChannel) {
    outputChannel.appendLine(`\n[Conflict] Local is ${info.localAhead} ahead, ${info.remoteBehind} behind remote.`);
    outputChannel.appendLine(`Remote commits:\n${info.diffSummary}`);
    outputChannel.show(true);
    const choice = await vscode.window.showWarningMessage(`Overleaf GitBridge: Remote has ${info.remoteBehind} new commit(s) and you have ${info.localAhead} local commit(s). How do you want to resolve?`, { modal: false }, 'Pull & Merge', 'Force Push', 'Open Terminal');
    if (choice === 'Pull & Merge') {
        try {
            const pullResult = await (0, gitUtils_1.execGit)(info.repoPath, ['pull', '--no-rebase', 'origin', 'master']);
            outputChannel.appendLine(`[Pull] ${pullResult}`);
            vscode.window.showInformationMessage('Overleaf GitBridge: Pull completed. Please resolve any merge conflicts in the editor.');
            return 'pulled';
        }
        catch (err) {
            outputChannel.appendLine(`[Pull Error] ${err.message}`);
            vscode.window.showErrorMessage(`Overleaf GitBridge: Pull failed — ${err.message}. Please resolve manually.`);
            return 'cancelled';
        }
    }
    if (choice === 'Force Push') {
        const confirm = await vscode.window.showWarningMessage('This will OVERWRITE remote changes with your local version. Are you sure?', { modal: true }, 'Yes, Force Push');
        if (confirm === 'Yes, Force Push') {
            try {
                // Create backup branch before force push
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const backupBranch = `backup/${ts}`;
                try {
                    await (0, gitUtils_1.execGit)(info.repoPath, ['branch', backupBranch, 'origin/master']);
                    outputChannel.appendLine(`[Backup] Created backup branch: ${backupBranch}`);
                }
                catch (backupErr) {
                    outputChannel.appendLine(`[Backup] Warning: could not create backup branch: ${backupErr.message}`);
                }
                const pushResult = await (0, gitUtils_1.execGit)(info.repoPath, ['push', '--force', 'origin', 'master']);
                outputChannel.appendLine(`[Force Push] ${pushResult}`);
                vscode.window.showInformationMessage(`Overleaf GitBridge: Force push completed. Backup: ${backupBranch}`);
                return 'force_pushed';
            }
            catch (err) {
                outputChannel.appendLine(`[Force Push Error] ${err.message}`);
                vscode.window.showErrorMessage(`Overleaf GitBridge: Force push failed — ${err.message}`);
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
//# sourceMappingURL=conflictHandler.js.map