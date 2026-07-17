import { spawn } from "node-pty";

import type { TuiAttachShellCommand } from "../attach/TuiAttachShellModel.js";
import { TuiTerminalBuffer } from "./TuiTerminalBuffer.js";
import type {
    TuiTerminalDisposable,
    TuiTerminalPty,
    TuiTerminalPtyFactory,
    TuiTerminalSnapshot,
    TuiTerminalStartOptions
} from "./TuiTerminalModel.js";

export class TuiTerminalSession {
    readonly #listeners = new Set<() => void>();
    readonly #ptyFactory: TuiTerminalPtyFactory;
    #buffer?: TuiTerminalBuffer;
    #bufferDataSubscription?: TuiTerminalDisposable;
    #command?: TuiAttachShellCommand;
    #fallbackCommands: TuiAttachShellCommand[] = [];
    #outputQueue: Promise<void> = Promise.resolve();
    #processGeneration = 0;
    #pty?: TuiTerminalPty;
    #ptyDataSubscription?: TuiTerminalDisposable;
    #ptyExitSubscription?: TuiTerminalDisposable;
    #snapshot: TuiTerminalSnapshot = emptySnapshot();

    constructor(options: { ptyFactory?: TuiTerminalPtyFactory } = {}) {
        this.#ptyFactory = options.ptyFactory ?? defaultPtyFactory;
    }

    dispose(): void {
        this.#processGeneration += 1;
        this.#disposeProcess();
        this.#bufferDataSubscription?.dispose();
        this.#bufferDataSubscription = undefined;
        this.#buffer?.dispose();
        this.#buffer = undefined;
        this.#listeners.clear();
    }

    getSnapshot(): TuiTerminalSnapshot {
        return this.#snapshot;
    }

    resize(columns: number, rows: number): void {
        const safeColumns = clampDimension(columns);
        const safeRows = clampDimension(rows);
        this.#buffer?.resize(safeColumns, safeRows);
        this.#pty?.resize(safeColumns, safeRows);
        this.#syncBuffer();
    }

    setError(message: string, columns = this.#snapshot.columns, rows = this.#snapshot.rows): void {
        this.#processGeneration += 1;
        this.#disposeProcess();
        this.#replaceSnapshot({
            ...emptySnapshot(columns, rows),
            error: message,
            message,
            status: "error"
        });
    }

    setUnavailable(message: string, columns: number, rows: number): void {
        this.#processGeneration += 1;
        this.#disposeProcess();
        this.#replaceSnapshot({
            ...emptySnapshot(columns, rows),
            message,
            status: "idle"
        });
    }

    async start(options: TuiTerminalStartOptions): Promise<void> {
        this.#disposeProcess();
        const generation = ++this.#processGeneration;
        this.#outputQueue = Promise.resolve();
        this.#bufferDataSubscription?.dispose();
        this.#buffer?.dispose();

        const columns = clampDimension(options.columns);
        const rows = clampDimension(options.rows);
        this.#buffer = new TuiTerminalBuffer({ columns, rows });
        this.#command = options.command;
        this.#fallbackCommands = [...(options.command.fallbackCommands ?? [])];
        this.#replaceSnapshot({
            ...this.#buffer.getSnapshot(),
            instance: options.instance,
            status: "starting"
        });
        this.#bufferDataSubscription = this.#buffer.onData((data) => {
            this.#pty?.write(data);
        });

        try {
            this.#spawn(options.command, options.environment, options.instance, generation);
        } catch (error) {
            this.#replaceSnapshot({
                ...this.#buffer.getSnapshot(),
                error: readErrorMessage(error),
                instance: options.instance,
                status: "error"
            });
        }
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    writeInput(data: string): void {
        if (this.#snapshot.status === "running") {
            this.#pty?.write(data);
        }
    }

    #spawn(command: TuiAttachShellCommand, environment: NodeJS.ProcessEnv | undefined, instance: string, generation: number): void {
        const columns = this.#snapshot.columns;
        const rows = this.#snapshot.rows;
        const pty = this.#ptyFactory(command.command, command.args, {
            columns,
            cwd: command.cwd ?? this.#command?.cwd,
            environment: terminalEnvironment(environment),
            rows
        });
        this.#pty = pty;
        this.#ptyDataSubscription = pty.onData((data) => {
            this.#outputQueue = this.#outputQueue.then(async () => {
                if (generation !== this.#processGeneration) {
                    return;
                }
                const buffer = this.#buffer;
                if (buffer === undefined) {
                    return;
                }
                await buffer.write(data);
                if (generation === this.#processGeneration) {
                    this.#syncBuffer();
                }
            }).catch((error: unknown) => {
                if (generation === this.#processGeneration) {
                    this.#replaceSnapshot({
                        ...this.#snapshot,
                        error: readErrorMessage(error),
                        status: "error"
                    });
                }
            });
        });
        this.#ptyExitSubscription = pty.onExit((event) => {
            void this.#outputQueue.then(() => {
                if (generation !== this.#processGeneration) {
                    return;
                }
                const fallback = event.exitCode === this.#command?.fallbackOnExitCode
                    ? this.#fallbackCommands.shift()
                    : undefined;
                if (fallback !== undefined) {
                    this.#disposeProcess(false);
                    try {
                        this.#spawn(fallback, environment, instance, generation);
                    } catch (error) {
                        this.#replaceSnapshot({
                            ...this.#snapshot,
                            error: readErrorMessage(error),
                            status: "error"
                        });
                    }
                    return;
                }
                this.#replaceSnapshot({
                    ...this.#snapshot,
                    exitCode: event.exitCode,
                    status: "exited"
                });
            });
        });
        this.#replaceSnapshot({
            ...this.#snapshot,
            error: undefined,
            instance,
            status: "running"
        });
    }

    #disposeProcess(kill = true): void {
        this.#ptyDataSubscription?.dispose();
        this.#ptyExitSubscription?.dispose();
        this.#ptyDataSubscription = undefined;
        this.#ptyExitSubscription = undefined;
        const pty = this.#pty;
        this.#pty = undefined;
        if (kill) {
            try {
                pty?.kill();
            } catch {
                // The PTY may already have exited.
            }
        }
    }

    #replaceSnapshot(snapshot: TuiTerminalSnapshot): void {
        this.#snapshot = snapshot;
        for (const listener of this.#listeners) {
            listener();
        }
    }

    #syncBuffer(): void {
        if (this.#buffer === undefined) {
            return;
        }
        this.#replaceSnapshot({
            ...this.#snapshot,
            ...this.#buffer.getSnapshot()
        });
    }
}

function defaultPtyFactory(command: string, args: readonly string[], options: Parameters<TuiTerminalPtyFactory>[2]): TuiTerminalPty {
    return spawn(command, [...args], {
        cols: options.columns,
        cwd: options.cwd,
        env: options.environment,
        name: "xterm-256color",
        rows: options.rows
    });
}

function terminalEnvironment(environment: NodeJS.ProcessEnv | undefined): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment ?? process.env)) {
        if (value !== undefined) {
            output[key] = value;
        }
    }
    output.TERM = "xterm-256color";
    output.COLORTERM ??= "truecolor";
    return output;
}

function emptySnapshot(columns = 1, rows = 1): TuiTerminalSnapshot {
    return {
        columns: clampDimension(columns),
        cursor: { x: 0, y: 0 },
        lines: [],
        rows: clampDimension(rows),
        status: "idle"
    };
}

function clampDimension(value: number): number {
    return Math.max(1, Math.floor(value));
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
