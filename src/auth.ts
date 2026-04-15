import * as vscode from 'vscode';

const KEY_GIT_TOKEN = 'overleaf-gitbridge.gitToken';
const KEY_COOKIE = 'overleaf-gitbridge.cookie';
const KEY_SERVER_URL = 'overleaf-gitbridge.serverUrl';

export class AuthStore {
    constructor(private secrets: vscode.SecretStorage) { }

    async saveToken(token: string): Promise<void> {
        await this.secrets.store(KEY_GIT_TOKEN, token);
    }

    async getToken(): Promise<string | undefined> {
        return this.secrets.get(KEY_GIT_TOKEN);
    }

    async saveCookie(cookie: string): Promise<void> {
        await this.secrets.store(KEY_COOKIE, cookie);
    }

    async getCookie(): Promise<string | undefined> {
        return this.secrets.get(KEY_COOKIE);
    }

    async saveServerUrl(url: string): Promise<void> {
        await this.secrets.store(KEY_SERVER_URL, url);
    }

    async getServerUrl(): Promise<string | undefined> {
        return this.secrets.get(KEY_SERVER_URL);
    }

    async clearAll(): Promise<void> {
        await this.secrets.delete(KEY_GIT_TOKEN);
        await this.secrets.delete(KEY_COOKIE);
        await this.secrets.delete(KEY_SERVER_URL);
    }
}
