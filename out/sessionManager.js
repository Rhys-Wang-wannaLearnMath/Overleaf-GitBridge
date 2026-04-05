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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const node_fetch_1 = __importDefault(require("node-fetch"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
function getAgent(url) {
    return url.startsWith('https') ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
}
/**
 * Merge new set-cookie values into the existing cookie string.
 * Overwrites cookies with the same key, appends new ones.
 */
function mergeCookies(existing, setCookieHeaders) {
    const cookieMap = new Map();
    // Parse existing cookies
    for (const part of existing.split(/;\s*/)) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            cookieMap.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
        }
    }
    // Parse new cookies from set-cookie headers
    for (const header of setCookieHeaders) {
        // Only take the first segment (before ;) which is key=value
        const segment = header.split(';')[0].trim();
        const eq = segment.indexOf('=');
        if (eq > 0) {
            cookieMap.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
        }
    }
    return Array.from(cookieMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}
/**
 * SessionManager keeps the Overleaf session alive by:
 * 1. Capturing `set-cookie` from every response and merging into stored cookies
 * 2. Periodically refreshing the CSRF token (every 10 minutes or on auth error)
 * 3. Auto-persisting updated cookies back to SecretStorage
 */
class SessionManager {
    constructor(identity, authStore, onLog) {
        this._lastCsrfRefresh = 0;
        this._identity = { ...identity };
        this._authStore = authStore;
        this._lastCsrfRefresh = Date.now();
        this._onLog = onLog || (() => { });
    }
    get identity() {
        return this._identity;
    }
    /**
     * Call this after every fetch response to capture and merge cookies.
     */
    async captureCookies(resHeaders) {
        const setCookie = resHeaders.raw()['set-cookie'];
        if (setCookie && setCookie.length > 0) {
            const oldCookies = this._identity.cookies;
            this._identity.cookies = mergeCookies(oldCookies, setCookie);
            if (this._identity.cookies !== oldCookies) {
                this._onLog('[Session] Cookies refreshed from server response');
                await this._authStore.saveCookie(this._identity.cookies);
            }
        }
    }
    /**
     * Refresh the CSRF token by fetching the project page.
     * Called automatically if the token is stale, or manually on auth errors.
     */
    async refreshCsrfToken() {
        const { serverUrl, cookies } = this._identity;
        try {
            this._onLog('[Session] Refreshing CSRF token...');
            const res = await (0, node_fetch_1.default)(`${serverUrl}/project`, {
                method: 'GET',
                redirect: 'manual',
                agent: getAgent(serverUrl),
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': cookies,
                },
            });
            // Capture any refreshed cookies
            await this.captureCookies(res.headers);
            const body = await res.text();
            const csrfMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/)
                || body.match(/<input.*name="_csrf".*value="([^"]*)">/)
                || body.match(/"csrfToken"\s*:\s*"([^"]*)"/);
            if (csrfMatch) {
                this._identity.csrfToken = csrfMatch[1];
                this._lastCsrfRefresh = Date.now();
                this._onLog('[Session] CSRF token refreshed successfully');
                return true;
            }
            else {
                this._onLog('[Session] Failed to extract CSRF token — cookie may have expired');
                return false;
            }
        }
        catch (err) {
            this._onLog(`[Session] CSRF refresh error: ${err.message}`);
            return false;
        }
    }
    /**
     * Ensure CSRF token is fresh. Call before each API request.
     */
    async ensureFreshToken() {
        const elapsed = Date.now() - this._lastCsrfRefresh;
        if (elapsed > SessionManager.CSRF_REFRESH_INTERVAL_MS) {
            await this.refreshCsrfToken();
        }
    }
    /**
     * Handle an auth error (401/403) by refreshing token and returning
     * true if caller should retry the request.
     */
    async handleAuthError() {
        this._onLog('[Session] Auth error detected, attempting token refresh...');
        return this.refreshCsrfToken();
    }
}
exports.SessionManager = SessionManager;
SessionManager.CSRF_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
//# sourceMappingURL=sessionManager.js.map