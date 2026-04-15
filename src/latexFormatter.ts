import * as vscode from 'vscode';
import * as Prettier from 'prettier';
import { prettierPluginLatex } from '@unified-latex/unified-latex-prettier';

async function prettierFormat(text: string, options: vscode.FormattingOptions): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('overleaf-gitlive');
    const lineBreakEnabled = cfg.get<boolean>('formatter.lineBreak', true);
    const printWidth = lineBreakEnabled ? cfg.get<number>('formatter.printWidth', 80) : 10000;

    return Prettier.format(text, {
        parser: 'latex-parser',
        tabWidth: options.tabSize,
        useTabs: !options.insertSpaces,
        plugins: [prettierPluginLatex],
        printWidth,
    });
}

const LATEX_LANGUAGES = ['latex', 'latex-expl3', 'pweave', 'jlweave', 'rsweave'];

function makeSelector(): vscode.DocumentFilter[] {
    return LATEX_LANGUAGES.map(language => ({ language, scheme: 'file' }));
}

class LatexDocumentFormatter implements vscode.DocumentFormattingEditProvider {
    async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options: vscode.FormattingOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.TextEdit[]> {
        const text = document.getText();
        try {
            const formatted = await prettierFormat(text, options);
            const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
            return [vscode.TextEdit.replace(fullRange, formatted)];
        } catch (err: any) {
            vscode.window.showErrorMessage(`LaTeX format error: ${err.message}`);
            return [];
        }
    }
}

class LatexRangeFormatter implements vscode.DocumentRangeFormattingEditProvider {
    async provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
        options: vscode.FormattingOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.TextEdit[]> {
        const text = document.getText(range);
        try {
            const formatted = await prettierFormat(text, options);
            return [vscode.TextEdit.replace(range, formatted)];
        } catch (err: any) {
            vscode.window.showErrorMessage(`LaTeX format error: ${err.message}`);
            return [];
        }
    }
}

export function registerFormatter(context: vscode.ExtensionContext): void {
    const cfg = vscode.workspace.getConfiguration('overleaf-gitlive');
    if (!cfg.get<boolean>('formatter.enabled', true)) {
        return;
    }

    const selector = makeSelector();
    const formatter = new LatexDocumentFormatter();
    const rangeFormatter = new LatexRangeFormatter();

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(selector, formatter),
        vscode.languages.registerDocumentRangeFormattingEditProvider(selector, rangeFormatter),
    );
}
