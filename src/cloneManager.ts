import * as vscode from 'vscode';
import { AuthStore } from './auth';
import { Credentials, loginWithCookies, fetchProjects } from './api';
import { execGit } from './gitUtils';

export class CloneManager {
    constructor(
        private authStore: AuthStore,
        private outputChannel: vscode.OutputChannel,
    ) { }

    async cloneProject(): Promise<string | undefined> {
        // 1. Ensure we have credentials
        const creds = await this.ensureCredentials();
        if (!creds) { return undefined; }

        // 2. Fetch project list
        const project = await this.pickProject(creds);
        if (!project) { return undefined; }

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
                vscode.window.showWarningMessage('Overleaf GitLive: Git token is required for cloning.');
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
        if (!targetParent || targetParent.length === 0) { return undefined; }

        const targetDir = vscode.Uri.joinPath(targetParent[0], project.name.replace(/[^a-zA-Z0-9_\-. ]/g, '_')).fsPath;

        // 5. Clone
        const cloneUrl = `https://git:${token}@git.overleaf.com/${project.id}`;
        this.log(`Cloning project "${project.name}" (${project.id})...`);

        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Overleaf GitLive: Cloning "${project.name}"...`, cancellable: false },
                async () => {
                    await execGit(targetParent[0].fsPath, ['clone', cloneUrl, targetDir]);
                },
            );
            this.log(`Clone successful: ${targetDir}`);
        } catch (err: any) {
            this.log(`Clone failed: ${err.message}`);
            vscode.window.showErrorMessage(`Overleaf GitLive: Clone failed — ${err.message}`);
            return undefined;
        }

        // 6. Open in new window
        const uri = vscode.Uri.file(targetDir);
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });

        return targetDir;
    }

    private async ensureCredentials(): Promise<Credentials | undefined> {
        let serverUrl = await this.authStore.getServerUrl();
        let cookie = await this.authStore.getCookie();

        if (!serverUrl) {
            serverUrl = await vscode.window.showInputBox({
                prompt: 'Overleaf Server URL',
                value: 'https://www.overleaf.com',
                ignoreFocusOut: true,
            });
            if (!serverUrl) { return undefined; }
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
            if (!cookieInput) { return undefined; }
            if (!cookieInput.includes('overleaf_session2=')) {
                cookieInput = `overleaf_session2=${cookieInput}`;
            }
            cookie = cookieInput;
        }

        // Validate by logging in
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Overleaf GitLive: Logging in...' },
            () => loginWithCookies(serverUrl!, cookie!),
        );

        if (!result.success || !result.creds) {
            vscode.window.showErrorMessage(`Overleaf GitLive: ${result.error || 'Login failed. Check your cookies.'}`);
            // Clear stored cookie since it's invalid
            await this.authStore.saveCookie('');
            return undefined;
        }

        // Save valid cookie
        await this.authStore.saveCookie(cookie);
        return result.creds;
    }

    private async pickProject(creds: Credentials): Promise<{ id: string; name: string } | undefined> {
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
            placeHolder: 'Select an Overleaf project to clone',
            matchOnDescription: true,
            ignoreFocusOut: true,
        });

        return picked ? { id: picked.projectId, name: picked.label } : undefined;
    }

    private log(msg: string): void {
        const ts = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${ts}] ${msg}`);
    }
}
