import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import {
    defaultEmulator,
    getRemoteSettings,
    getRunSettings,
    getToolchain,
    shouldUseEmulator
} from './config';
import { PasswordSource, getPasswordSource } from './remote';

function describePassword(source: PasswordSource): string {
    switch (source) {
        case 'settings':
            return 'in settings (clear text)';
        case 'secret-storage':
            return 'stored (secret storage)';
        case 'session':
            return 'this session only';
        default:
            return 'not set';
    }
}

export class ArmSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'armAsmBuilder.sidebar';

    private view?: vscode.WebviewView;

    constructor(private readonly context: vscode.ExtensionContext) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.html = this.getHtml();
        void this.postState();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            const commands: Record<string, string> = {
                build: 'arm-asm-builder.buildCurrentFile',
                run: 'arm-asm-builder.runLocal',
                remoteBuild: 'arm-asm-builder.remoteBuild',
                remoteRun: 'arm-asm-builder.remoteRun',
                configureRemote: 'arm-asm-builder.configureRemote',
                setPassword: 'arm-asm-builder.setRemotePassword',
                testConnection: 'arm-asm-builder.testRemoteConnection',
                cleanRemoteFolder: 'arm-asm-builder.cleanRemoteFolder',
                stop: 'arm-asm-builder.stopRun',
                openSettings: 'arm-asm-builder.openSettings'
            };

            const command = commands[message.command];

            if (!command) {
                return;
            }

            await vscode.commands.executeCommand(command);
            await this.postState();
        });
    }

    public refresh(): void {
        void this.postState();
    }

    private async postState(): Promise<void> {
        if (!this.view) {
            return;
        }

        const toolchain = getToolchain();
        const run = getRunSettings();
        const remote = getRemoteSettings();

        const emulated = shouldUseEmulator(toolchain, run);
        const runMode = emulated
            ? `emulated (${run.emulatorPath || defaultEmulator(toolchain.architecture)})`
            : 'native';

        this.view.webview.postMessage({
            type: 'state',
            architecture: toolchain.architecture,
            prefix: toolchain.prefix,
            linkWith: toolchain.linkWith + (toolchain.useNoStartFiles ? ' (-nostartfiles)' : ''),
            outputDirectory: toolchain.outputDirectory,
            runMode,
            laboratoryMode: remote.laboratoryMode,
            host: remote.host,
            port: remote.port,
            username: remote.username,
            workingDirectory: remote.workingDirectory,
            password: describePassword(await getPasswordSource(this.context, remote))
        });
    }

    private getHtml(): string {
        const htmlPath = path.join(this.context.extensionPath, 'resources', 'sidebar.html');

        try {
            return fs.readFileSync(htmlPath, 'utf8');
        } catch (err) {
            return `<!DOCTYPE html><html><body>Error loading sidebar: ${err}</body></html>`;
        }
    }
}
