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
exports.registerFormatter = registerFormatter;
const vscode = __importStar(require("vscode"));
const Prettier = __importStar(require("prettier"));
const unified_latex_prettier_1 = require("@unified-latex/unified-latex-prettier");
async function prettierFormat(text, options) {
    const cfg = vscode.workspace.getConfiguration('overleaf-gitbridge');
    const lineBreakEnabled = cfg.get('formatter.lineBreak', true);
    const printWidth = lineBreakEnabled ? cfg.get('formatter.printWidth', 80) : 10000;
    return Prettier.format(text, {
        parser: 'latex-parser',
        tabWidth: options.tabSize,
        useTabs: !options.insertSpaces,
        plugins: [unified_latex_prettier_1.prettierPluginLatex],
        printWidth,
    });
}
const LATEX_LANGUAGES = ['latex', 'latex-expl3', 'pweave', 'jlweave', 'rsweave'];
function makeSelector() {
    return LATEX_LANGUAGES.map(language => ({ language, scheme: 'file' }));
}
class LatexDocumentFormatter {
    async provideDocumentFormattingEdits(document, options, _token) {
        const text = document.getText();
        try {
            const formatted = await prettierFormat(text, options);
            const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
            return [vscode.TextEdit.replace(fullRange, formatted)];
        }
        catch (err) {
            vscode.window.showErrorMessage(`LaTeX format error: ${err.message}`);
            return [];
        }
    }
}
class LatexRangeFormatter {
    async provideDocumentRangeFormattingEdits(document, range, options, _token) {
        const text = document.getText(range);
        try {
            const formatted = await prettierFormat(text, options);
            return [vscode.TextEdit.replace(range, formatted)];
        }
        catch (err) {
            vscode.window.showErrorMessage(`LaTeX format error: ${err.message}`);
            return [];
        }
    }
}
function registerFormatter(context) {
    const cfg = vscode.workspace.getConfiguration('overleaf-gitbridge');
    if (!cfg.get('formatter.enabled', true)) {
        return;
    }
    const selector = makeSelector();
    const formatter = new LatexDocumentFormatter();
    const rangeFormatter = new LatexRangeFormatter();
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(selector, formatter), vscode.languages.registerDocumentRangeFormattingEditProvider(selector, rangeFormatter));
}
//# sourceMappingURL=latexFormatter.js.map