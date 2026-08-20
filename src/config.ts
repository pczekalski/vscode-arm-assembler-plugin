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
    laboratoryMode: boolean;
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
 * Device values that Laboratory Mode keeps in memory instead of on disk. Everything else in
 * the `remote` section is stored normally, so a lab administrator can still preset the
 * working directory or the toolchain for all students.
 */
export interface SessionRemote {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
}

export type SessionRemoteKey = keyof SessionRemote;

const SESSION_REMOTE_KEYS: SessionRemoteKey[] = ['host', 'port', 'username', 'password'];

/**
 * Lives for as long as the extension host does, which is exactly the lifetime Laboratory
 * Mode promises: what a student enters is forgotten when VS Code closes.
 */
let sessionRemote: SessionRemote = {};

export function isLaboratoryMode(): boolean {
    return getConfig().get<boolean>('remote.laboratoryMode', false);
}

export function getSessionRemote(): SessionRemote {
    return { ...sessionRemote };
}

export function setSessionRemote(key: SessionRemoteKey, value: string | number): void {
    if (key === 'port') {
        sessionRemote.port = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
        return;
    }

    sessionRemote[key] = String(value);
}

export function clearSessionRemote(key?: SessionRemoteKey): void {
    if (key) {
        delete sessionRemote[key];
        return;
    }

    sessionRemote = {};
}

/**
 * Maps a settings key such as `remote.host` onto the session field it belongs to, or
 * `undefined` for keys that are stored on disk even in Laboratory Mode.
 */
function sessionRemoteKeyOf(key: string): SessionRemoteKey | undefined {
    const match = /^remote\.(.+)$/.exec(key);
    const field = match?.[1] as SessionRemoteKey | undefined;

    return field && SESSION_REMOTE_KEYS.includes(field) ? field : undefined;
}

/**
 * Removes a setting from every scope that defines it. Used when Laboratory Mode takes the
 * device configuration off disk; writing an empty string instead would leave the key behind
 * in `settings.json` and still look configured.
 */
export async function clearPersistedSetting(key: string): Promise<boolean> {
    const config = getConfig();
    const scopes = config.inspect(key);
    let cleared = false;

    if (scopes?.globalValue !== undefined) {
        await config.update(key, undefined, vscode.ConfigurationTarget.Global);
        cleared = true;
    }

    if (scopes?.workspaceValue !== undefined) {
        await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        cleared = true;
    }

    if (scopes?.workspaceFolderValue !== undefined) {
        await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        cleared = true;
    }

    return cleared;
}

/**
 * The device as it is stored on disk, ignoring the session values that Laboratory Mode
 * layers on top.
 */
export function getPersistedRemoteDevice(): Required<SessionRemote> {
    const config = getConfig();

    return {
        host: config.get<string>('remote.host', '').trim(),
        port: config.get<number>('remote.port', 22),
        username: config.get<string>('remote.username', 'pi').trim(),
        password: config.get<string>('remote.password', '')
    };
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
    const sessionKey = sessionRemoteKeyOf(key);

    // In Laboratory Mode the device never reaches the disk: the prompts and the wizard write
    // into the session instead, and read back from it through getRemoteSettings().
    if (sessionKey && isLaboratoryMode()) {
        if (value === undefined || value === '') {
            clearSessionRemote(sessionKey);
        } else {
            setSessionRemote(sessionKey, value as string | number);
        }

        return;
    }

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
    const laboratoryMode = config.get<boolean>('remote.laboratoryMode', false);
    const session = laboratoryMode ? sessionRemote : {};

    return {
        laboratoryMode,
        host: (session.host ?? config.get<string>('remote.host', '')).trim(),
        port: session.port ?? config.get<number>('remote.port', 22),
        username: (session.username ?? config.get<string>('remote.username', 'pi')).trim(),
        password: session.password ?? config.get<string>('remote.password', ''),
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
