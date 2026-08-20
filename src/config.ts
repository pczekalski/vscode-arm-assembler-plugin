import * as vscode from 'vscode';
import * as path from 'path';

export const CONFIG_SECTION = 'arm-asm-builder';

export type Architecture = 'aarch64' | 'arm32';
export type LinkWith = 'gcc' | 'ld';
export type EmulatorMode = 'auto' | 'always' | 'never';

export interface ToolchainSettings {
    architecture: Architecture;
    prefix: string;
    assembler: string;
    linker: string;
    gcc: string;
    size: string;
    useReadelf: boolean;
    readelf: string;
    readelfFlags: string[];
    linkWith: LinkWith;
    useNoStartFiles: boolean;
    entrySymbol: string;
    assemblerFlags: string[];
    linkerFlags: string[];
    outputDirectory: string;
}

export interface RunSettings {
    useEmulator: EmulatorMode;
    emulatorPath: string;
    emulatorLibraryPath: string;
    arguments: string[];
    useIntegratedTerminal: boolean;
}

export interface RemoteSettings {
    host: string;
    port: number;
    username: string;
    password: string;
    workingDirectory: string;
    toolchainPrefix: string;
    uploadExtraFiles: string[];
    keepFiles: boolean;
    connectTimeout: number;
    strictHostKeyChecking: boolean;
}

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/**
 * Persists a setting so that what the user typed in a prompt is also what the Settings
 * editor shows.
 *
 * The value always goes to the User (global) scope, which is the tab the Settings editor
 * opens on. A workspace or folder scope that already defines the same key would otherwise
 * shadow it and leave the two views disagreeing, so any existing override is rewritten with
 * the same value instead of being left behind.
 */
export async function updateSetting(key: string, value: unknown): Promise<void> {
    const config = getConfig();
    const scopes = config.inspect(key);

    await config.update(key, value, vscode.ConfigurationTarget.Global);

    if (scopes?.workspaceValue !== undefined) {
        await config.update(key, value, vscode.ConfigurationTarget.Workspace);
    }

    if (scopes?.workspaceFolderValue !== undefined) {
        await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    }
}

/**
 * True when programs built for `architecture` can be executed directly by this machine.
 * Only Linux hosts qualify: the toolchain and the binary format have to match, and on
 * macOS the system assembler produces Mach-O rather than the ELF objects assumed here.
 */
export function isNativeHost(architecture: Architecture): boolean {
    if (process.platform !== 'linux') {
        return false;
    }

    return architecture === 'aarch64'
        ? process.arch === 'arm64'
        : process.arch === 'arm';
}

export function defaultToolchainPrefix(architecture: Architecture): string {
    if (isNativeHost(architecture)) {
        return '';
    }

    return architecture === 'aarch64'
        ? 'aarch64-linux-gnu-'
        : 'arm-linux-gnueabihf-';
}

export function defaultEmulator(architecture: Architecture): string {
    return architecture === 'aarch64' ? 'qemu-aarch64' : 'qemu-arm';
}

/**
 * Prefixes a tool name, unless the user configured an explicit path.
 */
export function applyPrefix(prefix: string, tool: string): string {
    if (!prefix) {
        return tool;
    }

    if (path.isAbsolute(tool) || tool.includes('/') || tool.includes('\\')) {
        return tool;
    }

    return prefix + tool;
}

export function getToolchain(): ToolchainSettings {
    const config = getConfig();
    const architecture = config.get<Architecture>('architecture', 'aarch64');

    const configuredPrefix = config.get<string>('toolchainPrefix', '').trim();
    const prefix = configuredPrefix.length > 0
        ? configuredPrefix
        : defaultToolchainPrefix(architecture);

    return {
        architecture,
        prefix,
        assembler: applyPrefix(prefix, config.get<string>('assemblerPath', 'as')),
        linker: applyPrefix(prefix, config.get<string>('linkerPath', 'ld')),
        gcc: applyPrefix(prefix, config.get<string>('gccPath', 'gcc')),
        size: applyPrefix(prefix, config.get<string>('sizePath', 'size')),
        useReadelf: config.get<boolean>('useReadelf', false),
        readelf: applyPrefix(prefix, config.get<string>('readelfPath', 'readelf')),
        readelfFlags: config.get<string[]>('readelfFlags', ['-W', '-h', '-s', '-S']),
        linkWith: config.get<LinkWith>('linkWith', 'gcc'),
        useNoStartFiles: config.get<boolean>('useNoStartFiles', true),
        entrySymbol: config.get<string>('entrySymbol', '_start').trim(),
        assemblerFlags: config.get<string[]>('assemblerFlags', ['-g']),
        linkerFlags: config.get<string[]>('linkerFlags', []),
        outputDirectory: config.get<string>('outputDirectory', 'build')
    };
}

export function getRunSettings(): RunSettings {
    const config = getConfig();

    return {
        useEmulator: config.get<EmulatorMode>('run.useEmulator', 'auto'),
        emulatorPath: config.get<string>('run.emulatorPath', '').trim(),
        emulatorLibraryPath: config.get<string>('run.emulatorLibraryPath', '').trim(),
        arguments: config.get<string[]>('run.arguments', []),
        useIntegratedTerminal: config.get<boolean>('run.useIntegratedTerminal', false)
    };
}

export function getRemoteSettings(): RemoteSettings {
    const config = getConfig();

    return {
        host: config.get<string>('remote.host', '').trim(),
        port: config.get<number>('remote.port', 22),
        username: config.get<string>('remote.username', 'pi').trim(),
        password: config.get<string>('remote.password', ''),
        workingDirectory: config.get<string>('remote.workingDirectory', '~/arm-asm-builder').trim(),
        toolchainPrefix: config.get<string>('remote.toolchainPrefix', '').trim(),
        uploadExtraFiles: config.get<string[]>('remote.uploadExtraFiles', []),
        keepFiles: config.get<boolean>('remote.keepFiles', true),
        connectTimeout: config.get<number>('remote.connectTimeout', 15000),
        strictHostKeyChecking: config.get<boolean>('remote.strictHostKeyChecking', true)
    };
}

/**
 * Decides whether a locally built binary is started through QEMU user-mode emulation.
 */
export function shouldUseEmulator(toolchain: ToolchainSettings, run: RunSettings): boolean {
    switch (run.useEmulator) {
        case 'always':
            return true;
        case 'never':
            return false;
        default:
            return !isNativeHost(toolchain.architecture);
    }
}
