import * as vscode from 'vscode';

import { CONFIG_SECTION, isLaboratoryMode } from './config';
import { buildCurrentFile, isArmSource, runLocally } from './build';
import { hasRunningProcess, stopAllProcesses } from './process';
import {
    clearRemotePassword,
    configureRemote,
    enterLaboratorySession,
    hasRemoteSession,
    remoteBuildAndRun,
    setRemotePassword,
    stopRemoteSessions,
    syncRemoteIdentity,
    testRemoteConnection
} from './remote';
import { ArmSidebarProvider } from './sidebar';

function updateButtonsVisibility(buttons: vscode.StatusBarItem[]): void {
    const editor = vscode.window.activeTextEditor;
    const visible = editor ? isArmSource(editor.document.fileName) : false;

    for (const button of buttons) {
        if (visible) {
            button.show();
        } else {
            button.hide();
        }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('ARM ASM Builder');
    const diagnostics = vscode.languages.createDiagnosticCollection('arm-asm-builder');
    const sidebarProvider = new ArmSidebarProvider(context);

    const register = (name: string, action: () => Promise<void>, failureText: string) =>
        vscode.commands.registerCommand(name, async () => {
            try {
                await action();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                output.show(true);
                output.appendLine(`\nERROR: ${message}`);
                vscode.window.showErrorMessage(`${failureText}: ${message}`);
            } finally {
                sidebarProvider.refresh();
            }
        });

    const commands = [
        register(
            'arm-asm-builder.buildCurrentFile',
            async () => { await buildCurrentFile(output, diagnostics); },
            'Build failed'
        ),
        register(
            'arm-asm-builder.runLocal',
            () => runLocally(output, diagnostics),
            'Run failed'
        ),
        register(
            'arm-asm-builder.remoteBuild',
            () => remoteBuildAndRun(context, output, diagnostics, false),
            'Remote build failed'
        ),
        register(
            'arm-asm-builder.remoteRun',
            () => remoteBuildAndRun(context, output, diagnostics, true),
            'Remote run failed'
        ),
        register(
            'arm-asm-builder.configureRemote',
            () => configureRemote(context),
            'Configuring the remote device failed'
        ),
        register(
            'arm-asm-builder.setRemotePassword',
            () => setRemotePassword(context),
            'Storing the password failed'
        ),
        register(
            'arm-asm-builder.clearRemotePassword',
            () => clearRemotePassword(context),
            'Clearing the password failed'
        ),
        register(
            'arm-asm-builder.testRemoteConnection',
            () => testRemoteConnection(context, output),
            'Remote connection test failed'
        ),
        register(
            'arm-asm-builder.stopRun',
            async () => {
                const stopped = stopAllProcesses() + stopRemoteSessions();

                if (stopped === 0) {
                    vscode.window.showInformationMessage('No ARM program is running.');
                    return;
                }

                output.appendLine('\nSTOPPED by user request.');
                vscode.window.showInformationMessage('Running ARM program stopped.');
            },
            'Stopping the program failed'
        ),
        register(
            'arm-asm-builder.openSettings',
            async () => {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    '@ext:pczekalski-dev.arm-assembler'
                );
            },
            'Opening the settings failed'
        )
    ];

    const buildButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    buildButton.text = '$(tools) ARM Build';
    buildButton.tooltip = 'Build the current ARM assembly file';
    buildButton.command = 'arm-asm-builder.buildCurrentFile';

    const runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    runButton.text = '$(play) ARM Run';
    runButton.tooltip = 'Build and run the current file on this machine';
    runButton.command = 'arm-asm-builder.runLocal';

    const remoteButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    remoteButton.text = '$(remote) ARM Remote Run';
    remoteButton.tooltip = 'Upload, build and run on the configured ARM device';
    remoteButton.command = 'arm-asm-builder.remoteRun';

    const stopButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    stopButton.text = '$(debug-stop) ARM Stop';
    stopButton.tooltip = 'Stop the running ARM program';
    stopButton.command = 'arm-asm-builder.stopRun';

    const statusButtons = [buildButton, runButton, remoteButton];

    const refreshStopButton = () => {
        if (hasRunningProcess() || hasRemoteSession()) {
            stopButton.show();
        } else {
            stopButton.hide();
        }
    };

    const stopButtonTimer = setInterval(refreshStopButton, 1000);

    setTimeout(() => {
        updateButtonsVisibility(statusButtons);
        refreshStopButton();
    }, 100);

    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
        updateButtonsVisibility(statusButtons);
    });

    const documentCloseDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
        diagnostics.delete(doc.uri);
    });

    const sidebarDisposable = vscode.window.registerWebviewViewProvider(
        ArmSidebarProvider.viewType,
        sidebarProvider
    );

    // Credentials are keyed by the device the settings describe, so an edit in the Settings
    // editor has to be carried over to the secret storage. Editing settings.json fires per
    // keystroke, so the work is deferred until the value stops changing.
    let remoteSyncTimer: NodeJS.Timeout | undefined;
    let laboratoryMode = isLaboratoryMode();

    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(CONFIG_SECTION)) {
            return;
        }

        sidebarProvider.refresh();

        if (!event.affectsConfiguration(`${CONFIG_SECTION}.remote`)) {
            return;
        }

        // Switching the mode on takes the device off disk straight away, keeping it usable
        // for the rest of this session.
        if (isLaboratoryMode() !== laboratoryMode) {
            laboratoryMode = !laboratoryMode;

            if (laboratoryMode) {
                void enterLaboratorySession(context, output, { absorb: true }).then(() => {
                    sidebarProvider.refresh();
                    vscode.window.showInformationMessage(
                        'Laboratory mode is on: the remote device is kept in this VS Code session only.'
                    );
                });

                return;
            }
        }

        if (remoteSyncTimer) {
            clearTimeout(remoteSyncTimer);
        }

        remoteSyncTimer = setTimeout(() => {
            remoteSyncTimer = undefined;
            void syncRemoteIdentity(context).then(() => sidebarProvider.refresh());
        }, 1500);
    });

    if (laboratoryMode) {
        // A previous session may have left a device behind on a shared computer.
        void enterLaboratorySession(context, output, { absorb: false })
            .then(() => sidebarProvider.refresh());
    } else {
        void syncRemoteIdentity(context);
    }

    context.subscriptions.push(
        output,
        diagnostics,
        ...commands,
        buildButton,
        runButton,
        remoteButton,
        stopButton,
        editorChangeDisposable,
        documentCloseDisposable,
        sidebarDisposable,
        configChangeDisposable,
        new vscode.Disposable(() => clearInterval(stopButtonTimer)),
        new vscode.Disposable(() => {
            if (remoteSyncTimer) {
                clearTimeout(remoteSyncTimer);
            }
        })
    );
}

export function deactivate(): void {
    stopAllProcesses();
    stopRemoteSessions();
}
