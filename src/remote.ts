import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { Client } from 'ssh2';

import {
    RemoteSettings,
    applyPrefix,
    clearPersistedSetting,
    clearSessionRemote,
    getPersistedRemoteDevice,
    getRemoteSettings,
    getSessionRemote,
    getRunSettings,
    getToolchain,
    isLaboratoryMode,
    setSessionRemote,
    updateSetting
} from './config';
import { publishDiagnosticsFromText } from './diagnostics';
import { shellQuote } from './process';
import {
    BuildPaths,
    getActiveDocument,
    getPaths,
    needsPreprocessor,
    validateDocument
} from './build';

const HOST_KEY_STATE = 'arm-asm-builder.knownHostKeys';
const REMOTE_IDENTITY_STATE = 'arm-asm-builder.remoteIdentity';
const KEEP_CLEAR_TEXT_PASSWORD_STATE = 'arm-asm-builder.keepClearTextPassword';

const activeConnections = new Set<Client>();

export type RemoteExecResult = {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
};

export interface RemoteSession {
    client: Client;
    settings: RemoteSettings;
    /** Absolute remote working directory, with `~` already expanded. */
    workDir: string;
}

/**
 * Closes every open SSH connection, which also terminates programs still running
 * in those sessions. Returns the number of connections that were closed.
 */
export function stopRemoteSessions(): number {
    const count = activeConnections.size;

    for (const client of activeConnections) {
        client.end();
    }

    activeConnections.clear();
    return count;
}

export function hasRemoteSession(): boolean {
    return activeConnections.size > 0;
}

/** The device a stored password belongs to. */
interface RemoteIdentity {
    host: string;
    port: number;
    username: string;
}

function identityOf(remote: RemoteSettings): RemoteIdentity {
    return { host: remote.host, port: remote.port, username: remote.username };
}

function describeIdentity(identity: RemoteIdentity): string {
    return `${identity.username}@${identity.host}:${identity.port}`;
}

function sameIdentity(a: RemoteIdentity, b: RemoteIdentity): boolean {
    return a.host === b.host && a.port === b.port && a.username === b.username;
}

function secretKeyFor(identity: RemoteIdentity): string {
    return `arm-asm-builder.password:${describeIdentity(identity)}`;
}

function secretKey(remote: RemoteSettings): string {
    return secretKeyFor(identityOf(remote));
}

/**
 * Carries the stored password over to the device the settings now describe.
 *
 * Passwords live in the secret storage under `user@host:port`, so editing the host, port
 * or user name in the Settings editor would otherwise orphan the stored password and make
 * the extension ask for it again, as if the change had not been picked up.
 */
async function movePasswordToNewIdentity(
    context: vscode.ExtensionContext,
    previous: RemoteIdentity,
    current: RemoteIdentity
): Promise<void> {
    if (!current.host || !current.username) {
        return;
    }

    const previousKey = secretKeyFor(previous);
    const currentKey = secretKeyFor(current);

    if (previousKey === currentKey) {
        return;
    }

    const stored = await context.secrets.get(previousKey);

    if (stored === undefined) {
        return;
    }

    // A password already stored for the new device wins; the old one is left untouched
    // rather than silently overwritten.
    if ((await context.secrets.get(currentKey)) !== undefined) {
        return;
    }

    await context.secrets.store(currentKey, stored);
    await context.secrets.delete(previousKey);

    vscode.window.showInformationMessage(
        `Remote device is now ${describeIdentity(current)}. The stored password moved with it; ` +
        'run "ARM: Set Remote Password" if the new device uses a different one.'
    );
}

/**
 * Offers to move a password typed into `remote.password` into the encrypted secret storage.
 * Asking rather than moving it silently keeps the Settings editor from changing under the
 * user's hands while they are still typing.
 */
async function offerToStoreClearTextPassword(
    context: vscode.ExtensionContext,
    remote: RemoteSettings
): Promise<void> {
    if (!remote.password || !remote.host || !remote.username) {
        return;
    }

    if (context.globalState.get<boolean>(KEEP_CLEAR_TEXT_PASSWORD_STATE, false)) {
        return;
    }

    const choice = await vscode.window.showWarningMessage(
        `The SSH password for ${remote.username}@${remote.host} is stored in clear text in settings.json.`,
        'Move to Secret Storage',
        'Keep in Settings'
    );

    if (choice === 'Move to Secret Storage') {
        await context.secrets.store(secretKey(remote), remote.password);
        await updateSetting('remote.password', '');
        vscode.window.showInformationMessage(
            'Password moved to the encrypted secret storage and removed from the settings.'
        );
        return;
    }

    if (choice === 'Keep in Settings') {
        await context.globalState.update(KEEP_CLEAR_TEXT_PASSWORD_STATE, true);
    }
}

/**
 * Keeps the stored credentials in step with the remote settings. Called once on activation
 * and after every change to `arm-asm-builder.remote.*`, so what the Settings editor shows
 * is what the next connection uses.
 */
export async function syncRemoteIdentity(context: vscode.ExtensionContext): Promise<void> {
    const remote = getRemoteSettings();

    // Laboratory Mode stores nothing, so there is no stored password to follow the device
    // and no clear-text password worth moving into the secret storage.
    if (remote.laboratoryMode) {
        return;
    }

    const current = identityOf(remote);
    const previous = context.globalState.get<RemoteIdentity>(REMOTE_IDENTITY_STATE);

    if (previous && !sameIdentity(previous, current)) {
        await movePasswordToNewIdentity(context, previous, current);
    }

    await context.globalState.update(REMOTE_IDENTITY_STATE, current);
    await offerToStoreClearTextPassword(context, remote);
}

/**
 * What the laboratory wipe removes from the settings: the whole device, address, port, user
 * name and password alike. Nothing about the device is stored in this mode, so nothing about
 * it can be inherited by the next student.
 */
const DEVICE_SETTING_KEYS = ['remote.host', 'remote.port', 'remote.username', 'remote.password'];

/**
 * Puts the computer into a Laboratory Mode session: the device configuration is removed from
 * the settings, from the secret storage and from the remembered host keys, so this VS Code
 * session starts from a clean slate and leaves nothing behind for the next student.
 *
 * `absorb` keeps the device that is currently configured usable for the rest of the session,
 * which is what a user switching the mode on mid-session expects. On startup it is off, so
 * whatever survived on the computer is simply dropped.
 */
export async function enterLaboratorySession(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    options: { absorb: boolean }
): Promise<void> {
    const persisted = getPersistedRemoteDevice();

    if (options.absorb) {
        if (persisted.host) {
            setSessionRemote('host', persisted.host);
        }

        setSessionRemote('port', persisted.port);

        if (persisted.username) {
            setSessionRemote('username', persisted.username);
        }

        if (persisted.password) {
            setSessionRemote('password', persisted.password);
        }
    } else {
        clearSessionRemote();
    }

    const cleared: string[] = [];

    for (const key of DEVICE_SETTING_KEYS) {
        if (await clearPersistedSetting(key)) {
            cleared.push(key);
        }
    }

    // Passwords are keyed by device, so the identity recorded earlier is the only handle on
    // what may still be in the secret storage.
    const identities: RemoteIdentity[] = [];
    const recorded = context.globalState.get<RemoteIdentity>(REMOTE_IDENTITY_STATE);

    if (recorded) {
        identities.push(recorded);
    }

    if (persisted.host && persisted.username) {
        identities.push({ host: persisted.host, port: persisted.port, username: persisted.username });
    }

    for (const identity of identities) {
        await context.secrets.delete(secretKeyFor(identity));
    }

    await context.globalState.update(REMOTE_IDENTITY_STATE, undefined);

    // The same address is a different machine in the next laboratory session, so a remembered
    // fingerprint would only produce a false "the host key has changed" warning.
    await context.globalState.update(HOST_KEY_STATE, undefined);

    output.appendLine('Laboratory mode: the remote device is kept in this VS Code session only.');

    if (cleared.length > 0) {
        output.appendLine(`Laboratory mode: cleared from the settings: ${cleared.join(', ')}.`);
    }
}

export type PasswordSource = 'settings' | 'secret-storage' | 'session' | 'none';

/**
 * Where the password for the configured device currently comes from. Reported in the
 * sidebar so a stored password is not mistaken for an empty Password setting.
 */
export async function getPasswordSource(
    context: vscode.ExtensionContext,
    remote: RemoteSettings = getRemoteSettings()
): Promise<PasswordSource> {
    if (remote.laboratoryMode) {
        if (getSessionRemote().password) {
            return 'session';
        }

        return remote.password ? 'settings' : 'none';
    }

    if (remote.password) {
        return 'settings';
    }

    if (!remote.host || !remote.username) {
        return 'none';
    }

    return (await context.secrets.get(secretKey(remote))) !== undefined
        ? 'secret-storage'
        : 'none';
}

export async function hasStoredPassword(
    context: vscode.ExtensionContext,
    remote: RemoteSettings = getRemoteSettings()
): Promise<boolean> {
    return (await getPasswordSource(context, remote)) !== 'none';
}

/**
 * Returns the SSH password, preferring the setting, then the encrypted secret
 * storage, and finally an interactive prompt whose result is stored.
 */
async function resolvePassword(
    context: vscode.ExtensionContext,
    remote: RemoteSettings
): Promise<string | undefined> {
    if (remote.password) {
        return remote.password;
    }

    // Laboratory Mode asks once per VS Code session and remembers the answer in memory only.
    if (remote.laboratoryMode) {
        const entered = await vscode.window.showInputBox({
            title: 'ARM Remote Password (laboratory mode)',
            prompt: `Password for ${remote.username}@${remote.host}:${remote.port} — kept for this VS Code session only`,
            password: true,
            ignoreFocusOut: true
        });

        if (entered === undefined) {
            return undefined;
        }

        setSessionRemote('password', entered);
        return entered;
    }

    const stored = await context.secrets.get(secretKey(remote));
    if (stored !== undefined) {
        return stored;
    }

    const entered = await vscode.window.showInputBox({
        title: 'ARM Remote Password',
        prompt: `Password for ${remote.username}@${remote.host}:${remote.port}`,
        password: true,
        ignoreFocusOut: true
    });

    if (entered === undefined) {
        return undefined;
    }

    await context.secrets.store(secretKey(remote), entered);
    return entered;
}

export async function setRemotePassword(context: vscode.ExtensionContext): Promise<void> {
    const remote = getRemoteSettings();

    if (!remote.host || !remote.username) {
        vscode.window.showErrorMessage(
            'Set the remote host and user name first (ARM: Configure Remote Device).'
        );
        return;
    }

    const entered = await vscode.window.showInputBox({
        title: remote.laboratoryMode ? 'ARM Remote Password (laboratory mode)' : 'ARM Remote Password',
        prompt: remote.laboratoryMode
            ? `Password for ${remote.username}@${remote.host}:${remote.port} — kept for this VS Code session only`
            : `Password for ${remote.username}@${remote.host}:${remote.port}`,
        password: true,
        ignoreFocusOut: true
    });

    if (entered === undefined) {
        return;
    }

    if (remote.laboratoryMode) {
        setSessionRemote('password', entered);
        vscode.window.showInformationMessage(
            `Password kept for ${remote.username}@${remote.host} in this VS Code session only (laboratory mode).`
        );
        return;
    }

    await context.secrets.store(secretKey(remote), entered);
    vscode.window.showInformationMessage(
        `Password stored securely for ${remote.username}@${remote.host}.`
    );
}

export async function clearRemotePassword(context: vscode.ExtensionContext): Promise<void> {
    const remote = getRemoteSettings();

    if (remote.laboratoryMode) {
        clearSessionRemote('password');
        vscode.window.showInformationMessage('Remote password cleared for this session.');
        return;
    }

    await context.secrets.delete(secretKey(remote));

    if (remote.password) {
        const choice = await vscode.window.showWarningMessage(
            'Stored password removed, but a password is still present in arm-asm-builder.remote.password.',
            'Clear It Too',
            'Keep It'
        );

        if (choice === 'Clear It Too') {
            await updateSetting('remote.password', '');
            vscode.window.showInformationMessage('Password removed from the settings as well.');
        }

        return;
    }

    vscode.window.showInformationMessage('Stored remote password removed.');
}

/**
 * Asks for the whole device and applies it in one go.
 *
 * Nothing is written until every answer is in: address, port, user name, working directory
 * and password are one unit, so escaping out of any prompt leaves the previous device exactly
 * as it was. A half-applied device — a new address still paired with the old password, say —
 * would otherwise fail to connect for reasons that are hard to see in the Settings editor.
 */
export async function configureRemote(context: vscode.ExtensionContext): Promise<void> {
    const remote = getRemoteSettings();
    const laboratoryMode = isLaboratoryMode();

    const cancelled = async (): Promise<void> => {
        vscode.window.showInformationMessage(
            'Remote device configuration cancelled. Nothing was changed.'
        );
    };

    const host = await vscode.window.showInputBox({
        title: 'ARM Remote Device (1/5)',
        prompt: 'IP address or host name of the ARM device',
        placeHolder: '192.168.1.50',
        value: remote.host,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? 'The host must not be empty.' : undefined)
    });

    if (host === undefined) {
        return cancelled();
    }

    const portText = await vscode.window.showInputBox({
        title: 'ARM Remote Device (2/5)',
        prompt: 'SSH port',
        value: String(remote.port),
        ignoreFocusOut: true,
        validateInput: (value) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
                ? undefined
                : 'Enter a port between 1 and 65535.';
        }
    });

    if (portText === undefined) {
        return cancelled();
    }

    const username = await vscode.window.showInputBox({
        title: 'ARM Remote Device (3/5)',
        prompt: 'SSH user name',
        value: remote.username,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? 'The user name must not be empty.' : undefined)
    });

    if (username === undefined) {
        return cancelled();
    }

    const workingDirectory = await vscode.window.showInputBox({
        title: 'ARM Remote Device (4/5)',
        prompt: 'Directory on the device for uploaded sources and binaries',
        value: remote.workingDirectory,
        ignoreFocusOut: true,
        validateInput: (value) =>
            (value.trim().length === 0 ? 'The working directory must not be empty.' : undefined)
    });

    if (workingDirectory === undefined) {
        return cancelled();
    }

    const password = await vscode.window.showInputBox({
        title: 'ARM Remote Device (5/5)',
        prompt: laboratoryMode
            ? `Password for ${username.trim()}@${host.trim()} (kept for this VS Code session only)`
            : `Password for ${username.trim()}@${host.trim()} (stored in the encrypted secret storage)`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
            (value.length === 0 ? 'The password must not be empty.' : undefined)
    });

    if (password === undefined) {
        return cancelled();
    }

    // Every answer is in, so the device can be applied as a whole. In Laboratory Mode
    // updateSetting() routes the four device values into the session instead of the disk.
    const port = Number.parseInt(portText, 10);

    await updateSetting('remote.host', host.trim());
    await updateSetting('remote.port', port);
    await updateSetting('remote.username', username.trim());
    await updateSetting('remote.workingDirectory', workingDirectory.trim());

    if (laboratoryMode) {
        setSessionRemote('password', password);
    } else {
        // Recorded before the password is stored, so the settings watcher sees an identity it
        // already knows and leaves the freshly stored password alone.
        await context.globalState.update(REMOTE_IDENTITY_STATE, identityOf(getRemoteSettings()));
        await context.secrets.store(secretKey(getRemoteSettings()), password);
    }

    const device = `${username.trim()}@${host.trim()}:${port}`;

    if (laboratoryMode) {
        // There is nothing to show in the Settings editor: the device only exists in memory.
        vscode.window.showInformationMessage(
            `Remote device set to ${device} for this VS Code session (laboratory mode).`
        );
        return;
    }

    // Show the result, so the values that were just entered are visible where they live.
    await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:pczekalski-dev.arm-assembler remote'
    );

    vscode.window.showInformationMessage(`Remote device saved: ${device}.`);
}

function fingerprintOf(key: Buffer): string {
    const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    return `SHA256:${digest}`;
}

async function verifyHostKey(
    context: vscode.ExtensionContext,
    remote: RemoteSettings,
    key: Buffer
): Promise<boolean> {
    const fingerprint = fingerprintOf(key);
    const store = context.globalState.get<Record<string, string>>(HOST_KEY_STATE, {});
    const id = `${remote.host}:${remote.port}`;
    const known = store[id];

    if (known === fingerprint) {
        return true;
    }

    if (known && known !== fingerprint) {
        const choice = await vscode.window.showWarningMessage(
            `The host key of ${id} has changed.\n\nKnown: ${known}\nOffered: ${fingerprint}\n\n` +
            'This can mean the device was reinstalled, or that the connection is being intercepted.',
            { modal: true },
            'Trust New Key',
            'Cancel'
        );

        if (choice !== 'Trust New Key') {
            return false;
        }

        await context.globalState.update(HOST_KEY_STATE, { ...store, [id]: fingerprint });
        return true;
    }

    const choice = await vscode.window.showInformationMessage(
        `Connecting to ${id} for the first time.\n\nHost key fingerprint:\n${fingerprint}\n\nTrust this device?`,
        { modal: true },
        'Trust',
        'Cancel'
    );

    if (choice !== 'Trust') {
        return false;
    }

    await context.globalState.update(HOST_KEY_STATE, { ...store, [id]: fingerprint });
    return true;
}

function connect(
    context: vscode.ExtensionContext,
    remote: RemoteSettings,
    password: string
): Promise<Client> {
    return new Promise((resolve, reject) => {
        const client = new Client();

        const onReady = () => {
            client.removeListener('error', onError);
            resolve(client);
        };

        const onError = (err: Error) => {
            client.removeListener('ready', onReady);
            activeConnections.delete(client);
            reject(err);
        };

        client.once('ready', onReady);
        client.once('error', onError);
        client.once('close', () => activeConnections.delete(client));

        activeConnections.add(client);

        client.connect({
            host: remote.host,
            port: remote.port,
            username: remote.username,
            password,
            readyTimeout: remote.connectTimeout,
            keepaliveInterval: 10000,
            hostVerifier: remote.strictHostKeyChecking
                ? (key: Buffer, callback: (valid: boolean) => void) => {
                    verifyHostKey(context, remote, key).then(callback, () => callback(false));
                }
                : undefined
        });
    });
}

export function execRemote(
    client: Client,
    command: string,
    output: vscode.OutputChannel,
    options: { echo?: boolean } = {}
): Promise<RemoteExecResult> {
    const { echo = true } = options;

    return new Promise((resolve, reject) => {
        if (echo) {
            output.appendLine(`$ ${command}`);
        }

        client.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            let stdout = '';
            let stderr = '';
            let code: number | null = null;
            let signal: string | null = null;

            stream.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                output.append(text);
            });

            stream.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                stderr += text;
                output.append(text);
            });

            stream.on('exit', (exitCode: number | null, exitSignal?: string | null) => {
                code = exitCode;
                signal = exitSignal ?? null;
            });

            stream.on('close', () => {
                resolve({ code, signal, stdout, stderr });
            });

            stream.on('error', reject);
        });
    });
}

function uploadFile(client: Client, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        client.sftp((err, sftp) => {
            if (err) {
                reject(err);
                return;
            }

            sftp.fastPut(localPath, remotePath, (putErr) => {
                if (putErr) {
                    reject(new Error(`Upload of ${path.basename(localPath)} failed: ${putErr.message}`));
                    return;
                }

                resolve();
            });
        });
    });
}

/**
 * Expands `~` in the configured working directory using the remote home directory.
 */
async function resolveWorkDir(
    client: Client,
    remote: RemoteSettings,
    output: vscode.OutputChannel
): Promise<string> {
    const configured = remote.workingDirectory || '~/arm-asm-builder';

    if (!configured.startsWith('~')) {
        return configured;
    }

    const result = await execRemote(client, 'printf %s "$HOME"', output, { echo: false });
    const home = result.stdout.trim();

    if (!home) {
        throw new Error('Could not determine the home directory on the remote device.');
    }

    return path.posix.join(home, configured.slice(1).replace(/^\/+/, ''));
}

async function openSession(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): Promise<RemoteSession | undefined> {
    const remote = getRemoteSettings();

    if (!remote.host) {
        const choice = await vscode.window.showErrorMessage(
            'No remote device configured.',
            'Configure Remote Device'
        );

        if (choice) {
            await configureRemote(context);
        }

        return undefined;
    }

    const password = await resolvePassword(context, remote);

    if (password === undefined) {
        return undefined;
    }

    output.appendLine(`Connecting to ${remote.username}@${remote.host}:${remote.port} ...`);

    let client: Client;

    try {
        client = await connect(context, remote, password);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`CONNECTION FAILED: ${message}`);

        if (/authentication/i.test(message)) {
            const choice = await vscode.window.showErrorMessage(
                `SSH authentication failed for ${remote.username}@${remote.host}.`,
                'Set Password'
            );

            if (choice) {
                await context.secrets.delete(secretKey(remote));
                await setRemotePassword(context);
            }
        } else {
            vscode.window.showErrorMessage(`SSH connection failed: ${message}`);
        }

        return undefined;
    }

    output.appendLine('Connected.');

    try {
        const workDir = await resolveWorkDir(client, remote, output);
        return { client, settings: remote, workDir };
    } catch (err) {
        client.end();
        activeConnections.delete(client);
        throw err;
    }
}

function closeSession(session: RemoteSession | undefined): void {
    if (!session) {
        return;
    }

    session.client.end();
    activeConnections.delete(session.client);
}

export async function testRemoteConnection(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): Promise<void> {
    output.clear();
    output.show(true);

    let session: RemoteSession | undefined;

    try {
        session = await openSession(context, output);

        if (!session) {
            return;
        }

        const toolchain = getToolchain();
        const prefix = session.settings.toolchainPrefix;
        const assembler = applyPrefix(prefix, 'as');

        output.appendLine('');
        await execRemote(session.client, 'uname -a', output);
        await execRemote(session.client, `${shellQuote(assembler)} --version | head -n 1`, output);
        await execRemote(session.client, `mkdir -p ${shellQuote(session.workDir)} && echo "work dir: ${session.workDir}"`, output);

        output.appendLine('');
        output.appendLine(`Target architecture in settings: ${toolchain.architecture}`);
        output.appendLine('CONNECTION OK');
        vscode.window.showInformationMessage(
            `Connected to ${session.settings.username}@${session.settings.host}.`
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`\nERROR: ${message}`);
        vscode.window.showErrorMessage(`Remote connection test failed: ${message}`);
    } finally {
        closeSession(session);
    }
}

function remoteLinkCommand(
    prefix: string,
    objectName: string,
    binaryName: string
): string {
    const toolchain = getToolchain();

    if (toolchain.linkWith === 'ld') {
        const parts = [shellQuote(applyPrefix(prefix, 'ld'))];

        if (toolchain.entrySymbol) {
            parts.push('-e', shellQuote(toolchain.entrySymbol));
        }

        parts.push(shellQuote(objectName), '-o', shellQuote(binaryName));
        parts.push(...toolchain.linkerFlags.map(shellQuote));
        return parts.join(' ');
    }

    const parts = [shellQuote(applyPrefix(prefix, 'gcc'))];

    if (toolchain.useNoStartFiles) {
        parts.push('-nostartfiles');

        if (toolchain.entrySymbol) {
            parts.push(shellQuote(`-Wl,-e,${toolchain.entrySymbol}`));
        }
    }

    parts.push(shellQuote(objectName), '-o', shellQuote(binaryName));
    parts.push(...toolchain.linkerFlags.map(shellQuote));
    return parts.join(' ');
}

/**
 * Uploads the active source file (plus any configured extra files), builds it on the
 * device and optionally runs the resulting binary there.
 */
export async function remoteBuildAndRun(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection,
    execute: boolean
): Promise<void> {
    const doc = getActiveDocument();

    if (!doc) {
        vscode.window.showErrorMessage('No active editor.');
        return;
    }

    const validationError = validateDocument(doc);
    if (validationError) {
        vscode.window.showErrorMessage(validationError);
        return;
    }

    await doc.save();
    diagnostics.clear();

    const toolchain = getToolchain();
    const run = getRunSettings();
    const local: BuildPaths = getPaths(doc, toolchain);

    const sourceName = path.basename(local.source);
    const baseName = path.basename(local.source, path.extname(local.source));
    const objectName = `${baseName}.o`;
    const binaryName = `${baseName}.elf`;

    output.clear();
    output.show(true);

    let session: RemoteSession | undefined;

    try {
        session = await openSession(context, output);

        if (!session) {
            return;
        }

        const prefix = session.settings.toolchainPrefix;
        const workDir = session.workDir;
        const remoteSource = path.posix.join(workDir, sourceName);

        output.appendLine(`Work dir : ${workDir}`);
        output.appendLine(`Source   : ${local.source}`);
        output.appendLine('');

        const mkdirResult = await execRemote(
            session.client,
            `mkdir -p ${shellQuote(workDir)}`,
            output
        );

        if (mkdirResult.code !== 0) {
            output.appendLine(`\nFAILED to create ${workDir} on the device.`);
            vscode.window.showErrorMessage('Could not create the remote working directory.');
            return;
        }

        // Upload the source and any extra files the project needs.
        const uploads: Array<{ local: string; remote: string }> = [
            { local: local.source, remote: remoteSource }
        ];

        for (const extra of session.settings.uploadExtraFiles) {
            const absolute = path.isAbsolute(extra) ? extra : path.resolve(local.baseDir, extra);
            const relative = path.relative(local.baseDir, absolute).split(path.sep).join('/');
            const target = path.posix.join(workDir, relative.startsWith('..') ? path.basename(absolute) : relative);

            const parent = path.posix.dirname(target);
            if (parent !== workDir) {
                await execRemote(session.client, `mkdir -p ${shellQuote(parent)}`, output, { echo: false });
            }

            uploads.push({ local: absolute, remote: target });
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Uploading to ${session.settings.host}`
            },
            async () => {
                for (const upload of uploads) {
                    output.appendLine(`upload ${upload.local} -> ${upload.remote}`);
                    await uploadFile(session!.client, upload.local, upload.remote);
                }
            }
        );

        output.appendLine('');

        // The assembler reports paths relative to the remote working directory;
        // map them back onto the local files so the Problems panel stays clickable.
        const remoteToLocal = new Map<string, string>();
        for (const upload of uploads) {
            remoteToLocal.set(upload.remote, upload.local);
            remoteToLocal.set(path.posix.basename(upload.remote), upload.local);
        }

        const mapPath = (reported: string): string | undefined =>
            remoteToLocal.get(reported) ?? remoteToLocal.get(path.posix.basename(reported));

        // A `.S` source has to go through the C preprocessor, which only the gcc driver runs.
        const assembleTool = needsPreprocessor(local.source)
            ? applyPrefix(prefix, 'gcc')
            : applyPrefix(prefix, 'as');

        const assembleCommand = [
            `cd ${shellQuote(workDir)} &&`,
            shellQuote(assembleTool),
            ...(needsPreprocessor(local.source) ? ['-c'] : []),
            ...toolchain.assemblerFlags.map(shellQuote),
            '-o', shellQuote(objectName),
            shellQuote(sourceName)
        ].join(' ');

        const assembleResult = await execRemote(session.client, assembleCommand, output);

        publishDiagnosticsFromText(assembleResult.stderr, diagnostics, {
            baseDir: local.baseDir,
            source: `remote ${assembleTool}`,
            mapPath
        });

        if (assembleResult.code !== 0) {
            output.appendLine('\nFAILED at remote assemble');
            vscode.window.showErrorMessage('Remote build failed at assemble stage.');
            return;
        }

        const linkCommand = `cd ${shellQuote(workDir)} && ${remoteLinkCommand(prefix, objectName, binaryName)}`;
        const linkResult = await execRemote(session.client, linkCommand, output);

        publishDiagnosticsFromText(linkResult.stderr, diagnostics, {
            baseDir: local.baseDir,
            source: `remote ${toolchain.linkWith}`,
            mapPath
        });

        if (linkResult.code !== 0) {
            output.appendLine('\nFAILED at remote link');
            vscode.window.showErrorMessage('Remote build failed at link stage.');
            return;
        }

        output.appendLine('\nSIZE:');
        await execRemote(
            session.client,
            `cd ${shellQuote(workDir)} && ${shellQuote(applyPrefix(prefix, 'size'))} ${shellQuote(binaryName)}`,
            output
        );

        if (toolchain.useReadelf) {
            output.appendLine('\nREADELF:');
            const readelfCommand = [
                `cd ${shellQuote(workDir)} &&`,
                shellQuote(applyPrefix(prefix, 'readelf')),
                ...toolchain.readelfFlags.map(shellQuote),
                shellQuote(binaryName)
            ].join(' ');

            const readelfResult = await execRemote(session.client, readelfCommand, output);

            if (readelfResult.code !== 0) {
                output.appendLine('\nWarning: remote readelf failed; the ELF report is not available.');
            }
        }

        output.appendLine(`\nREMOTE BUILD OK -> ${path.posix.join(workDir, binaryName)}`);

        if (!execute) {
            vscode.window.showInformationMessage('Remote build OK');
            return;
        }

        const runCommandLine = [
            `cd ${shellQuote(workDir)} &&`,
            `chmod +x ${shellQuote(binaryName)} &&`,
            `./${binaryName}`,
            ...run.arguments.map(shellQuote)
        ].join(' ');

        output.appendLine('');
        output.appendLine('RUN:');

        const runResult = await execRemote(session.client, runCommandLine, output);

        const exitText = runResult.signal
            ? `terminated by signal ${runResult.signal}`
            : `exit code ${runResult.code ?? 'unknown'}`;

        output.appendLine(`\nPROGRAM FINISHED (${exitText})`);

        if (runResult.code === 0) {
            vscode.window.showInformationMessage('Remote program finished with exit code 0');
        } else {
            vscode.window.showWarningMessage(`Remote program finished: ${exitText}`);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`\nERROR: ${message}`);
        vscode.window.showErrorMessage(`Remote operation failed: ${message}`);
    } finally {
        if (session && !session.settings.keepFiles) {
            try {
                await execRemote(
                    session.client,
                    `rm -f ${shellQuote(path.posix.join(session.workDir, sourceName))} ` +
                    `${shellQuote(path.posix.join(session.workDir, objectName))} ` +
                    `${shellQuote(path.posix.join(session.workDir, binaryName))}`,
                    output
                );
            } catch {
                // Cleanup is best effort; a failure here must not mask the build result.
            }
        }

        closeSession(session);
    }
}
