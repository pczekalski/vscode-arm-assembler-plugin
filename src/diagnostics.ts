import * as vscode from 'vscode';
import * as path from 'path';

// file:line:column: error|warning|note: message
const WITH_COLUMN = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note|Error|Warning):\s*(.*)$/;

// file:line: error|warning|note: message
const WITHOUT_COLUMN = /^(.*?):(\d+):\s*(fatal error|error|warning|note|Error|Warning):\s*(.*)$/;

function severityFromText(kind: string): vscode.DiagnosticSeverity {
    switch (kind.toLowerCase()) {
        case 'warning':
            return vscode.DiagnosticSeverity.Warning;
        case 'note':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Error;
    }
}

function resolveCompilerPath(filePathText: string, currentBaseDir: string): string {
    if (path.isAbsolute(filePathText)) {
        return path.normalize(filePathText);
    }

    return path.normalize(path.resolve(currentBaseDir, filePathText));
}

export interface DiagnosticOptions {
    /** Base directory used to resolve relative paths reported by the toolchain. */
    baseDir: string;
    /** Value shown in the Problems panel as the origin of the message. */
    source: string;
    /**
     * Maps a path reported by the toolchain to a local file. Used for remote builds,
     * where the assembler reports paths that only exist on the device.
     */
    mapPath?: (reportedPath: string) => string | undefined;
}

/**
 * Parses GNU toolchain diagnostics out of `text` and publishes them to the Problems panel.
 */
export function publishDiagnosticsFromText(
    text: string,
    diagnostics: vscode.DiagnosticCollection,
    options: DiagnosticOptions
): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const line of text.split(/\r?\n/)) {
        let match = WITH_COLUMN.exec(line);
        let filePathText: string | undefined;
        let lineNumber = 1;
        let columnNumber = 1;
        let severityText = 'error';
        let message = '';

        if (match) {
            filePathText = match[1];
            lineNumber = Number.parseInt(match[2], 10);
            columnNumber = Number.parseInt(match[3], 10);
            severityText = match[4];
            message = match[5];
        } else {
            match = WITHOUT_COLUMN.exec(line);
            if (!match) {
                continue;
            }
            filePathText = match[1];
            lineNumber = Number.parseInt(match[2], 10);
            columnNumber = 1;
            severityText = match[3];
            message = match[4];
        }

        if (!filePathText) {
            continue;
        }

        const mapped = options.mapPath?.(filePathText);
        const absolutePath = mapped ?? resolveCompilerPath(filePathText, options.baseDir);
        const uri = vscode.Uri.file(absolutePath);

        const startLine = Math.max(0, lineNumber - 1);
        const startColumn = Math.max(0, columnNumber - 1);

        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(startLine, startColumn, startLine, startColumn + 1),
            message,
            severityFromText(severityText)
        );

        diagnostic.source = options.source;

        const existing = byFile.get(uri.fsPath) ?? [];
        existing.push(diagnostic);
        byFile.set(uri.fsPath, existing);
    }

    for (const [file, items] of byFile.entries()) {
        diagnostics.set(vscode.Uri.file(file), items);
    }
}
