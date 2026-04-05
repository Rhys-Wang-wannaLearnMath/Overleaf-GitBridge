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
exports.loginWithCookies = loginWithCookies;
exports.fetchProjects = fetchProjects;
exports.compile = compile;
exports.downloadPdf = downloadPdf;
const node_fetch_1 = __importDefault(require("node-fetch"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
function getAgent(url) {
    return url.startsWith('https') ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
}
async function loginWithCookies(serverUrl, cookies) {
    try {
        const res = await (0, node_fetch_1.default)(`${serverUrl}/project`, {
            method: 'GET',
            redirect: 'manual',
            agent: getAgent(serverUrl),
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            },
        });
        const body = await res.text();
        const csrfMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/)
            || body.match(/<input.*name="_csrf".*value="([^"]*)">/)
            || body.match(/"csrfToken"\s*:\s*"([^"]*)"/);
        if (!csrfMatch) {
            return { success: false, error: 'Failed to extract CSRF token. Cookies may be invalid or expired.' };
        }
        return {
            success: true,
            creds: { serverUrl, cookies, csrfToken: csrfMatch[1] },
        };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
async function fetchProjects(creds) {
    const { serverUrl, cookies } = creds;
    try {
        const res = await (0, node_fetch_1.default)(`${serverUrl}/user/projects`, {
            method: 'GET',
            redirect: 'manual',
            agent: getAgent(serverUrl),
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            },
        });
        if (res.status !== 200) {
            return { success: false, error: `Fetch projects failed: ${res.status}` };
        }
        const data = await res.json();
        const projects = (data.projects || []).map((p) => ({
            id: p._id || p.id,
            name: p.name,
            lastUpdated: p.lastUpdated,
            owner: p.owner,
        }));
        return { success: true, projects };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
async function compile(identity, session) {
    if (session) {
        await session.ensureFreshToken();
    }
    const id = session ? session.identity : identity;
    const { serverUrl, projectId, cookies, csrfToken } = id;
    const url = `${serverUrl}/project/${projectId}/compile?auto_compile=true`;
    const body = JSON.stringify({
        _csrf: csrfToken,
        check: 'silent',
        draft: false,
        incrementalCompilesEnabled: true,
        rootResourcePath: id.rootResourcePath,
        stopOnFirstError: false,
    });
    const doCompile = async () => {
        const currentId = session ? session.identity : identity;
        const res = await (0, node_fetch_1.default)(url, {
            method: 'POST',
            redirect: 'manual',
            agent: getAgent(serverUrl),
            headers: {
                'Connection': 'keep-alive',
                'Cookie': currentId.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': currentId.csrfToken,
            },
            body: JSON.stringify({
                _csrf: currentId.csrfToken,
                check: 'silent',
                draft: false,
                incrementalCompilesEnabled: true,
                rootResourcePath: currentId.rootResourcePath,
                stopOnFirstError: false,
            }),
        });
        if (session) {
            await session.captureCookies(res.headers);
        }
        if (res.status === 403 || res.status === 401) {
            return { success: false, error: `auth_error:${res.status}` };
        }
        if (res.status !== 200) {
            const errBody = await res.text().catch(() => '');
            return { success: false, error: `Compile failed (${res.status}): ${errBody.slice(0, 200)}` };
        }
        const data = await res.json();
        if (data.status !== 'success') {
            return { success: false, error: `Compile status: ${data.status}` };
        }
        const outputFiles = data.outputFiles || [];
        const pdfFile = outputFiles.find((f) => f.path === 'output.pdf');
        const buildId = outputFiles[0]?.url?.match(/\/build\/([^/]+)/)?.[1];
        return {
            success: true,
            buildId,
            outputFiles,
            pdfUrl: pdfFile?.url,
        };
    };
    try {
        let result = await doCompile();
        // Auto-retry on auth error with refreshed token
        if (!result.success && result.error?.startsWith('auth_error:') && session) {
            const refreshed = await session.handleAuthError();
            if (refreshed) {
                result = await doCompile();
            }
        }
        return result;
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
async function downloadPdf(serverUrl, cookies, pdfUrl, session) {
    const url = `${serverUrl}/${pdfUrl.replace(/^\/+/, '')}`;
    const agent = getAgent(serverUrl);
    const maxRetries = 4;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const currentCookies = session ? session.identity.cookies : cookies;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            const res = await (0, node_fetch_1.default)(url, {
                method: 'GET',
                redirect: 'follow',
                agent,
                signal: controller.signal,
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': currentCookies,
                    'Accept': 'application/pdf',
                },
            });
            clearTimeout(timeout);
            if (session) {
                await session.captureCookies(res.headers);
            }
            if (res.status === 200 || res.status === 206) {
                const buf = await res.buffer();
                if (buf.length < 100) {
                    throw new Error(`PDF too small (${buf.length} bytes), likely incomplete`);
                }
                return buf;
            }
            else if (res.status === 404) {
                throw new Error('PDF not found (404). Compile may still be in progress.');
            }
            else if ((res.status === 401 || res.status === 403) && session) {
                const refreshed = await session.handleAuthError();
                if (refreshed && attempt < maxRetries - 1) {
                    continue;
                }
                throw new Error(`Auth error (${res.status}). Cookie may have expired.`);
            }
            else if (res.status === 401 || res.status === 403) {
                throw new Error(`Auth error (${res.status}). Cookie may have expired.`);
            }
            else {
                throw new Error(`Download failed: HTTP ${res.status}`);
            }
        }
        catch (err) {
            const isLast = attempt === maxRetries - 1;
            if (isLast) {
                throw err;
            }
            const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error('Download failed after all retries');
}
//# sourceMappingURL=api.js.map