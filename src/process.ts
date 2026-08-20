import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';

export type RunResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
};

const runningProcesses = new Set<ChildProcess>();

export function hasRunningProcess(): boolean {
    return runningProcesses.size > 0;
}

/**
 * Terminates every process started by this extension. Returns the number of
 * processes that were asked to stop.
 */
export function stopAllProcesses(): number {
    const count = runningProcesses.size;

    for (const child of runningProcesses) {
        child.kill('SIGTERM');
    }

    return count;
}

export function runCommand(
    command: string,
    args: string[],
    cwd: string,
    output: vscode.OutputChannel,
    options: { echo?: boolean; track?: boolean } = {}
): Promise<RunResult> {
    const { echo = true, track = false } = options;

    return new Promise((resolve, reject) => {
        if (echo) {
            output.appendLine(`> ${command} ${args.join(' ')}`);
        }

        const child = spawn(command, args, {
            cwd,
            shell: false
        });

        if (track) {
            runningProcesses.add(child);
        }

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer | string) => {
            const text = data.toString();
            stdout += text;
            output.append(text);
        });

        child.stderr.on('data', (data: Buffer | string) => {
            const text = data.toString();
            stderr += text;
            output.append(text);
        });

        child.on('error', (err: Error) => {
            runningProcesses.delete(child);
            reject(err);
        });

        child.on('close', (code, signal) => {
            runningProcesses.delete(child);
            resolve({
                code,
                signal,
                stdout,
                stderr
            });
        });
    });
}

/**
 * Wraps an argument for a POSIX shell, used when composing remote commands.
 */
export function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
    }

    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function describeExit(result: RunResult): string {
    if (result.signal) {
        return `terminated by signal ${result.signal}`;
    }

    return `exit code ${result.code ?? 'unknown'}`;
}
