"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthStore = void 0;
const KEY_GIT_TOKEN = 'overleaf-gitbridge.gitToken';
const KEY_COOKIE = 'overleaf-gitbridge.cookie';
const KEY_SERVER_URL = 'overleaf-gitbridge.serverUrl';
class AuthStore {
    constructor(secrets) {
        this.secrets = secrets;
    }
    async saveToken(token) {
        await this.secrets.store(KEY_GIT_TOKEN, token);
    }
    async getToken() {
        return this.secrets.get(KEY_GIT_TOKEN);
    }
    async saveCookie(cookie) {
        await this.secrets.store(KEY_COOKIE, cookie);
    }
    async getCookie() {
        return this.secrets.get(KEY_COOKIE);
    }
    async saveServerUrl(url) {
        await this.secrets.store(KEY_SERVER_URL, url);
    }
    async getServerUrl() {
        return this.secrets.get(KEY_SERVER_URL);
    }
    async clearAll() {
        await this.secrets.delete(KEY_GIT_TOKEN);
        await this.secrets.delete(KEY_COOKIE);
        await this.secrets.delete(KEY_SERVER_URL);
    }
}
exports.AuthStore = AuthStore;
//# sourceMappingURL=auth.js.map