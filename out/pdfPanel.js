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
exports.PdfPanel = void 0;
const vscode = __importStar(require("vscode"));
class PdfPanel {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this.disposables = [];
    }
    show() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        this.panel = vscode.window.createWebviewPanel('myviewpdf.preview', 'PDF Preview', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
        });
    }
    update(pdfBuffer) {
        if (!this.panel) {
            return;
        }
        const base64 = pdfBuffer.toString('base64');
        this.panel.webview.postMessage({ type: 'update', data: base64 });
    }
    dispose() {
        this.panel?.dispose();
    }
    getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>PDF Preview</title>
<style>
    html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:#525659; font-family:sans-serif; }
    #toolbar {
        position:fixed; top:0; left:0; right:0; z-index:200;
        display:flex; align-items:center; justify-content:center; gap:6px;
        background:rgba(30,30,30,0.92); padding:5px 12px; backdrop-filter:blur(4px);
        border-bottom:1px solid rgba(255,255,255,0.1);
    }
    #toolbar button {
        background:rgba(255,255,255,0.12); border:none; color:#ddd; font-size:13px;
        padding:4px 10px; border-radius:4px; cursor:pointer; min-width:32px;
    }
    #toolbar button:hover { background:rgba(255,255,255,0.22); color:#fff; }
    #toolbar .sep { width:1px; height:18px; background:rgba(255,255,255,0.15); margin:0 4px; }
    #toolbar #scaleLabel { color:#ccc; font-size:12px; min-width:48px; text-align:center; }
    #container {
        width:100%; height:100%; overflow:auto; display:flex; flex-direction:column; align-items:center;
        padding-top:42px; box-sizing:border-box;
    }
    canvas { display:block; margin:8px auto; box-shadow:0 2px 8px rgba(0,0,0,0.3); }
    #status {
        position:fixed; bottom:8px; right:12px; color:#fff; background:rgba(0,0,0,0.6);
        padding:4px 10px; border-radius:4px; font-size:11px; z-index:100;
    }
</style>
</head>
<body>
<div id="toolbar">
    <button id="btnZoomOut" title="Zoom Out (Cmd -)">−</button>
    <span id="scaleLabel">150%</span>
    <button id="btnZoomIn" title="Zoom In (Cmd +)">+</button>
    <div class="sep"></div>
    <button id="btnFitWidth" title="Fit Width">Fit W</button>
    <button id="btnFitPage" title="Fit Page">Fit P</button>
    <div class="sep"></div>
    <button id="btnReset" title="Reset to 150%">Reset</button>
</div>
<div id="container"></div>
<div id="status">Waiting for PDF...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const container = document.getElementById('container');
    const statusEl = document.getElementById('status');
    const scaleLabel = document.getElementById('scaleLabel');
    const vscodeApi = acquireVsCodeApi();

    let currentPdf = null;
    let lastPdfData = null;
    let scale = 1.5;
    const SCALE_STEP = 0.25;
    const SCALE_MIN = 0.25;
    const SCALE_MAX = 5.0;

    function setStatus(msg) { statusEl.textContent = msg; }
    function updateScaleLabel() { scaleLabel.textContent = Math.round(scale * 100) + '%'; }

    async function renderPdf(data, keepScroll) {
        try {
            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const scrollFraction = keepScroll && container.scrollHeight > 0
                ? container.scrollTop / container.scrollHeight : 0;

            const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
            currentPdf = pdf;
            lastPdfData = data;

            container.innerHTML = '';
            updateScaleLabel();

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                container.appendChild(canvas);
                const ctx = canvas.getContext('2d');
                await page.render({ canvasContext: ctx, viewport }).promise;
            }

            if (keepScroll) container.scrollTop = scrollFraction * container.scrollHeight;
            setStatus('PDF loaded (' + pdf.numPages + ' pages)');
        } catch (err) {
            setStatus('Render error: ' + err.message);
        }
    }

    function rerender() {
        if (lastPdfData) { setStatus('Rendering...'); renderPdf(lastPdfData, true); }
    }

    async function fitWidth() {
        if (!currentPdf) return;
        const page = await currentPdf.getPage(1);
        const unscaledW = page.getViewport({ scale: 1.0 }).width;
        scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, (container.clientWidth - 24) / unscaledW));
        rerender();
    }

    async function fitPage() {
        if (!currentPdf) return;
        const page = await currentPdf.getPage(1);
        const vp = page.getViewport({ scale: 1.0 });
        const availH = container.clientHeight - 20;
        const availW = container.clientWidth - 24;
        scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.min(availW / vp.width, availH / vp.height)));
        rerender();
    }

    document.getElementById('btnZoomIn').onclick = () => {
        scale = Math.min(SCALE_MAX, scale + SCALE_STEP); rerender();
    };
    document.getElementById('btnZoomOut').onclick = () => {
        scale = Math.max(SCALE_MIN, scale - SCALE_STEP); rerender();
    };
    document.getElementById('btnReset').onclick = () => { scale = 1.5; rerender(); };
    document.getElementById('btnFitWidth').onclick = fitWidth;
    document.getElementById('btnFitPage').onclick = fitPage;

    // Ctrl/Cmd + / - / 0 shortcuts
    window.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey) {
            if (e.key === '=' || e.key === '+') { e.preventDefault(); scale = Math.min(SCALE_MAX, scale + SCALE_STEP); rerender(); }
            else if (e.key === '-') { e.preventDefault(); scale = Math.max(SCALE_MIN, scale - SCALE_STEP); rerender(); }
            else if (e.key === '0') { e.preventDefault(); scale = 1.5; rerender(); }
        }
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'update' && msg.data) {
            setStatus('Rendering...');
            renderPdf(msg.data, true);
        }
    });

    setStatus('Waiting for PDF...');
</script>
</body>
</html>`;
    }
}
exports.PdfPanel = PdfPanel;
//# sourceMappingURL=pdfPanel.js.map