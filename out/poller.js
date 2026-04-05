"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PdfPoller = void 0;
const api_1 = require("./api");
class PdfPoller {
    constructor(identity, intervalMs = 10000, onUpdate, onError, onStatus, session) {
        this.identity = identity;
        this.intervalMs = intervalMs;
        this.onUpdate = onUpdate;
        this.onError = onError;
        this.onStatus = onStatus;
        this.session = session;
        this.polling = false;
        this._isStarted = false;
    }
    start() {
        if (this._isStarted) {
            return;
        }
        this._isStarted = true;
        this.onStatus('PDF preview started');
        this.poll(); // immediate first poll
        if (this.intervalMs > 0) {
            this.timer = setInterval(() => this.poll(), this.intervalMs);
        }
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this._isStarted = false;
        this.onStatus('PDF preview stopped');
    }
    get isRunning() {
        return this._isStarted;
    }
    /** Trigger a single compile+download cycle (e.g. after push). */
    triggerOnce() {
        if (!this._isStarted) {
            return;
        }
        this.poll();
    }
    async poll() {
        if (this.polling) {
            return;
        }
        this.polling = true;
        try {
            this.onStatus('Compiling...');
            const id = this.session ? this.session.identity : this.identity;
            const result = await (0, api_1.compile)(id, this.session);
            if (!result.success) {
                this.onError(`Compile failed: ${result.error}`);
                this.polling = false;
                return;
            }
            if (!result.buildId || !result.pdfUrl) {
                this.onError('No PDF in compile output');
                this.polling = false;
                return;
            }
            if (result.buildId === this.lastBuildId) {
                this.onStatus('No changes detected');
                this.polling = false;
                return;
            }
            this.onStatus('Downloading PDF...');
            const currentId = this.session ? this.session.identity : this.identity;
            const pdfBuffer = await (0, api_1.downloadPdf)(currentId.serverUrl, currentId.cookies, result.pdfUrl, this.session);
            this.lastBuildId = result.buildId;
            this.onUpdate(pdfBuffer, result.buildId);
            this.onStatus(`Updated (build: ${result.buildId.slice(0, 12)}...)`);
        }
        catch (err) {
            this.onError(`Poll error: ${err.message}`);
        }
        this.polling = false;
    }
}
exports.PdfPoller = PdfPoller;
//# sourceMappingURL=poller.js.map