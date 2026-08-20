import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import {
    ToolchainSettings,
    getRunSettings,
    getToolchain,
    shouldUseEmulator,
    defaultEmulator,
    isNativeHost
} from './config';
import { publishDiagnosticsFromText } from './diagnostics';
import { describeExit, runCommand } from './process';

export const SOURCE_EXTENSIONS = ['.s', '.asm'];

export type BuildPaths = {
    source: string;
    baseDir: string;
    buildDir: string;
    object: string;
    binary: string;
};

export function isArmSource(fileName: string): boolean {
    // `.S` (capital) is a GNU assembly source passed through the C preprocessor.
    if (path.extname(fileName) === '.S') {
        return true;
    }

    return SOURCE_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

export function getActiveDocument(): vscode.TextDocument | undefined {
    return vscode.window.activeTextEditor?.document;
}

export function validateDocument(doc: vscode.TextDocument): string | undefined {
    if (doc.isUntitled) {
        return 'Please save the file first.';
    }

    if (!isArmSource(doc.fileName)) {
        return 'This command only supports .s, .S and .asm files.';
    }

    if (!fs.existsSync(doc.fileName)) {
        return 'Source file does not exist on disk.';
    }

    return undefined;
}

export function getPaths(doc: vscode.TextDocument, toolchain: ToolchainSettings): BuildPaths {
    const source = doc.fileName;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const baseDir = workspaceFolder?.uri.fsPath ?? path.dirname(source);
    const buildDir = path.resolve(baseDir, toolchain.outputDirectory);

    fs.mkdirSync(buildDir, { recursive: true });

    const baseName = path.basename(source, path.extname(source));

    return {
        source,
        baseDir,
        buildDir,
        object: path.join(buildDir, `${baseName}.o`),
        binary: path.join(buildDir, `${baseName}.elf`)
    };
}

/**
 * A capital `.S` extension means the source goes through the C preprocessor, which only the
 * gcc driver runs. Lower case `.s` and `.asm` files go straight to the assembler.
 */
export function needsPreprocessor(source: string): boolean {
    return path.extname(source) === '.S';
}

/**
 * Arguments for the assemble stage.
 */
export function getAssembleCommand(
    toolchain: ToolchainSettings,
    source: string,
    objectFile: string
): { command: string; args: string[] } {
    if (needsPreprocessor(source)) {
        return {
            command: toolchain.gcc,
            args: ['-c', ...toolchain.assemblerFlags, '-o', objectFile, source]
        };
    }

    return {
        command: toolchain.assembler,
        args: [...toolchain.assemblerFlags, '-o', objectFile, source]
    };
}

/**
 * Arguments for the link stage. `gcc` keeps the C library reachable, `ld` produces a
 * freestanding binary that has to rely on raw syscalls.
 */
export function getLinkCommand(
    toolchain: ToolchainSettings,
    objectFile: string,
    binaryFile: string
): { command: string; args: string[] } {
    if (toolchain.linkWith === 'ld') {
        const args: string[] = [];

        if (toolchain.entrySymbol) {
            args.push('-e', toolchain.entrySymbol);
        }

        args.push(objectFile, '-o', binaryFile, ...toolchain.linkerFlags);
        return { command: toolchain.linker, args };
    }

    const args: string[] = [];

    if (toolchain.useNoStartFiles) {
        args.push('-nostartfiles');

        if (toolchain.entrySymbol) {
            args.push(`-Wl,-e,${toolchain.entrySymbol}`);
        }
    }

    args.push(objectFile, '-o', binaryFile, ...toolchain.linkerFlags);
    return { command: toolchain.gcc, args };
}

function toolMissingHint(command: string, toolchain: ToolchainSettings): string {
    const hint = toolchain.prefix
        ? `Install a cross toolchain providing "${command}", or adjust arm-asm-builder.toolchainPrefix.`
        : `Install the GNU binutils/gcc toolchain providing "${command}", or set an explicit path in the settings.`;

    return `${command} could not be started. ${hint}`;
}

export async function buildCurrentFile(
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection
): Promise<BuildPaths | undefined> {
    const doc = getActiveDocument();

    if (!doc) {
        vscode.window.showErrorMessage('No active editor.');
        return undefined;
    }

    const validationError = validateDocument(doc);
    if (validationError) {
        vscode.window.showErrorMessage(validationError);
        return undefined;
    }

    await doc.save();
    diagnostics.clear();

    const toolchain = getToolchain();
    const p = getPaths(doc, toolchain);

    output.clear();
    output.show(true);

    output.appendLine(`Source   : ${p.source}`);
    output.appendLine(`Build    : ${p.buildDir}`);
    output.appendLine(`Arch     : ${toolchain.architecture}`);
    output.appendLine(`Toolchain: ${toolchain.prefix || '(native)'}`);
    output.appendLine(`Link with: ${toolchain.linkWith}${toolchain.useNoStartFiles ? ' -nostartfiles' : ''}`);
    output.appendLine('');

    const assemble = getAssembleCommand(toolchain, p.source, p.object);

    const assembleResult = await runCommand(
        assemble.command,
        assemble.args,
        p.baseDir,
        output
    ).catch((err: Error) => {
        output.appendLine(`\n${toolMissingHint(assemble.command, toolchain)}`);
        throw err;
    });

    publishDiagnosticsFromText(assembleResult.stderr, diagnostics, {
        baseDir: p.baseDir,
        source: assemble.command
    });

    if (assembleResult.code !== 0) {
        output.appendLine(`\nFAILED at assemble (${describeExit(assembleResult)})`);
        vscode.window.showErrorMessage('ARM build failed at assemble stage.');
        return undefined;
    }

    const link = getLinkCommand(toolchain, p.object, p.binary);

    const linkResult = await runCommand(link.command, link.args, p.baseDir, output)
        .catch((err: Error) => {
            output.appendLine(`\n${toolMissingHint(link.command, toolchain)}`);
            throw err;
        });

    publishDiagnosticsFromText(linkResult.stderr, diagnostics, {
        baseDir: p.baseDir,
        source: link.command
    });

    if (linkResult.code !== 0) {
        output.appendLine(`\nFAILED at link (${describeExit(linkResult)})`);
        vscode.window.showErrorMessage('ARM build failed at link stage.');
        return undefined;
    }

    output.appendLine('\nSIZE:');
    const sizeResult = await runCommand(toolchain.size, [p.binary], p.baseDir, output)
        .catch(() => undefined);

    if (!sizeResult || sizeResult.code !== 0) {
        output.appendLine(`\nWarning: ${toolchain.size} failed; section sizes are not available.`);
    }

    output.appendLine(`\nBUILD OK -> ${p.binary}`);
    vscode.window.showInformationMessage('ARM build OK');
    return p;
}

/**
 * Command line used to start a locally built binary, either directly or under QEMU.
 */
export function getLocalRunCommand(
    toolchain: ToolchainSettings,
    binary: string
): { command: string; args: string[]; emulated: boolean } {
    const run = getRunSettings();

    if (!shouldUseEmulator(toolchain, run)) {
        return { command: binary, args: [...run.arguments], emulated: false };
    }

    const emulator = run.emulatorPath || defaultEmulator(toolchain.architecture);
    const args: string[] = [];

    if (run.emulatorLibraryPath) {
        args.push('-L', run.emulatorLibraryPath);
    }

    args.push(binary, ...run.arguments);
    return { command: emulator, args, emulated: true };
}

export async function runLocally(
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection
): Promise<void> {
    const p = await buildCurrentFile(output, diagnostics);

    if (!p) {
        return;
    }

    const toolchain = getToolchain();
    const run = getRunSettings();
    const invocation = getLocalRunCommand(toolchain, p.binary);

    output.appendLine('');
    output.appendLine('RUN:');

    if (!invocation.emulated && !isNativeHost(toolchain.architecture)) {
        output.appendLine(
            `Warning: this host is ${process.platform}/${process.arch} and the binary targets ` +
            `${toolchain.architecture}. Set arm-asm-builder.run.useEmulator to "auto" or "always" to run it under QEMU.`
        );
    }

    if (run.useIntegratedTerminal) {
        const terminal = vscode.window.createTerminal({ name: 'ARM Run', cwd: p.baseDir });
        terminal.show(true);
        terminal.sendText([invocation.command, ...invocation.args].join(' '));
        output.appendLine(`> ${invocation.command} ${invocation.args.join(' ')} (integrated terminal)`);
        return;
    }

    let result;

    try {
        result = await runCommand(
            invocation.command,
            invocation.args,
            p.baseDir,
            output,
            { track: true }
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`\nRUN FAILED: ${message}`);

        if (invocation.emulated) {
            output.appendLine(
                `Install the QEMU user-mode emulator "${invocation.command}" ` +
                '(Debian/Ubuntu: sudo apt install qemu-user), or point arm-asm-builder.run.emulatorPath at it.'
            );
        }

        vscode.window.showErrorMessage(`Run failed: ${message}`);
        return;
    }

    output.appendLine(`\nPROGRAM FINISHED (${describeExit(result)})`);

    if (result.code === 0) {
        vscode.window.showInformationMessage('Program finished with exit code 0');
    } else {
        vscode.window.showWarningMessage(`Program finished: ${describeExit(result)}`);
    }
}
