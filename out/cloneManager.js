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
exports.CloneManager = void 0;
const vscode = __importStar(require("vscode"));
const api_1 = require("./api");
const gitUtils_1 = require("./gitUtils");
class CloneManager {
    constructor(authStore, outputChannel) {
        this.authStore = authStore;
        this.outputChannel = outputChannel;
    }
    async cloneProject() {
        // 1. Ensure we have credentials
        const creds = await this.ensureCredentials();
        if (!creds) {
            return undefined;
        }
        // 2. Fetch project list
        const project = await this.pickProject(creds);
        if (!project) {
            return undefined;
        }
        // 3. Get git token
        let token = await this.authStore.getToken();
        if (!token) {
            token = await vscode.window.showInputBox({
                prompt: 'Enter your Overleaf Git token (from Account Settings → Git Integration)',
                placeHolder: 'Paste your token here',
                password: true,
                ignoreFocusOut: true,
            });
            if (!token) {
                vscode.window.showWarningMessage('Overleaf GitBridge: Git token is required for cloning.');
                return undefined;
            }
            await this.authStore.saveToken(token);
        }
        // 4. Pick target directory
        const targetParent = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select parent folder for clone',
        });
        if (!targetParent || targetParent.length === 0) {
            return undefined;
        }
        const targetDir = vscode.Uri.joinPath(targetParent[0], project.name.replace(/[^a-zA-Z0-9_\-. ]/g, '_')).fsPath;
        // 5. Clone
        const cloneUrl = `https://git:${token}@git.overleaf.com/${project.id}`;
        this.log(`Cloning project "${project.name}" (${project.id})...`);
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Overleaf GitBridge: Cloning "${project.name}"...`, cancellable: false }, async () => {
                await (0, gitUtils_1.execGit)(targetParent[0].fsPath, ['clone', cloneUrl, targetDir]);
            });
            this.log(`Clone successful: ${targetDir}`);
        }
        catch (err) {
            this.log(`Clone failed: ${err.message}`);
            vscode.window.showErrorMessage(`Overleaf GitBridge: Clone failed — ${err.message}`);
            return undefined;
        }
        // 6. Open in new window
        const uri = vscode.Uri.file(targetDir);
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        return targetDir;
    }
    async ensureCredentials() {
        let serverUrl = await this.authStore.getServerUrl();
        let cookie = await this.authStore.getCookie();
        if (!serverUrl) {
            serverUrl = await vscode.window.showInputBox({
                prompt: 'Overleaf Server URL',
                value: 'https://www.overleaf.com',
                ignoreFocusOut: true,
            });
            if (!serverUrl) {
                return undefined;
            }
            await this.authStore.saveServerUrl(serverUrl.replace(/\/+$/, ''));
            serverUrl = serverUrl.replace(/\/+$/, '');
        }
        if (!cookie) {
            let cookieInput = await vscode.window.showInputBox({
                prompt: 'Overleaf Cookie (paste cookie value)',
                placeHolder: 'Paste your overleaf_session2 cookie value',
                password: true,
                ignoreFocusOut: true,
            });
            if (!cookieInput) {
                return undefined;
            }
            if (!cookieInput.includes('overleaf_session2=')) {
                cookieInput = `overleaf_session2=${cookieInput}`;
            }
            cookie = cookieInput;
        }
        // Validate by logging in
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Overleaf GitBridge: Logging in...' }, () => (0, api_1.loginWithCookies)(serverUrl, cookie));
        if (!result.success || !result.creds) {
            vscode.window.showErrorMessage(`Overleaf GitBridge: ${result.error || 'Login failed. Check your cookies.'}`);
            // Clear stored cookie since it's invalid
            await this.authStore.saveCookie('');
            return undefined;
        }
        // Save valid cookie
        await this.authStore.saveCookie(cookie);
        return result.creds;
    }
    async pickProject(creds) {
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Overleaf GitBridge: Fetching projects...' }, () => (0, api_1.fetchProjects)(creds));
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
            placeHolder: 'Select an Overleaf project to clone',
            matchOnDescription: true,
            ignoreFocusOut: true,
        });
        return picked ? { id: picked.projectId, name: picked.label } : undefined;
    }
    log(msg) {
        const ts = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${ts}] ${msg}`);
    }
}
exports.CloneManager = CloneManager;
//# sourceMappingURL=cloneManager.js.map