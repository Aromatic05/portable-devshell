import { spawn } from "node-pty";

import type { TuiAttachShellCommand } from "../attach/TuiAttachShellModel.js";
import { TuiTerminalBuffer } from "./TuiTerminalBuffer.js";
import { TuiTerminalGraphicsParser, type TuiTerminalOutputToken } from "./TuiTerminalGraphicsParser.js";
import type {
    TuiTerminalDisposable,
    TuiTerminalGraphic,
    TuiTerminalMouseEvent,
    TuiTerminalPty,
    TuiTerminalPtyFactory,
    TuiTerminalSnapshot,
    TuiTerminalStartOptions,
    TuiTerminalVisibleGraphic
} from "./TuiTerminalModel.js";

export class TuiTerminalSession {
    readonly #listeners = new Set<() => void>();
    readonly #ptyFactory: TuiTerminalPtyFactory;
    #buffer?: TuiTerminalBuffer;
    #bufferDataSubscription?: TuiTerminalDisposable;
    #command?: TuiAttachShellCommand;
    #fallbackCommands: TuiAttachShellCommand[] = [];
    #focused = false;
    #graphicsParser = new TuiTerminalGraphicsParser();
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
        this.#graphicsParser.reset();
        this.#listeners.clear();
    }

    getSnapshot(): TuiTerminalSnapshot {
        return this.#snapshot;
    }

    getVisibleGraphics(): TuiTerminalVisibleGraphic[] {
        return this.#buffer?.getVisibleGraphics() ?? [];
    }

    takePendingGraphics(): TuiTerminalGraphic[] {
        return this.#buffer?.takePendingGraphics() ?? [];
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
        this.#graphicsParser.reset();
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
        this.#buffer.setFocused(this.#focused);

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

    beginSelection(x: number, y: number): void {
        this.#buffer?.beginSelection(x, y);
        this.#syncBuffer();
    }

    clearSelection(): void {
        this.#buffer?.clearSelection();
        this.#syncBuffer();
    }

    getSelectionText(): string {
        return this.#buffer?.getSelectionText() ?? "";
    }

    paste(data: string): void {
        if (this.#snapshot.status === "running") {
            this.#buffer?.paste(data);
            this.#syncBuffer();
        }
    }

    scrollPages(amount: number): void {
        this.#buffer?.scrollPages(amount);
        this.#syncBuffer();
    }

    scrollLines(amount: number): void {
        this.#buffer?.scrollLines(amount);
        this.#syncBuffer();
    }

    scrollToBottom(): void {
        this.#buffer?.scrollToBottom();
        this.#syncBuffer();
    }

    scrollToTop(): void {
        this.#buffer?.scrollToTop();
        this.#syncBuffer();
    }

    sendMouse(event: TuiTerminalMouseEvent): boolean {
        const sent = this.#buffer?.sendMouse(event) ?? false;
        if (sent) {
            this.#syncBuffer();
        }
        return sent;
    }

    setFocused(focused: boolean): void {
        this.#focused = focused;
        this.#buffer?.setFocused(focused);
    }

    updateSelection(x: number, y: number): void {
        this.#buffer?.updateSelection(x, y);
        this.#syncBuffer();
    }

    writeInput(data: string): void {
        if (this.#snapshot.status === "running") {
            this.#buffer?.input(data);
            this.#syncBuffer();
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
            const tokens = this.#graphicsParser.push(data);
            this.#outputQueue = this.#outputQueue.then(async () => {
                await this.#writeOutputTokens(tokens, generation);
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
            const finalTokens = this.#graphicsParser.flush();
            void this.#outputQueue.then(async () => {
                if (generation !== this.#processGeneration) {
                    return;
                }
                await this.#writeOutputTokens(finalTokens, generation);
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

    async #writeOutputTokens(tokens: readonly TuiTerminalOutputToken[], generation: number): Promise<void> {
        if (generation !== this.#processGeneration) {
            return;
        }
        const buffer = this.#buffer;
        if (buffer === undefined) {
            return;
        }
        for (const token of tokens) {
            if (token.type === "graphic") {
                buffer.recordGraphic(token.protocol, token.data);
            }
            await buffer.write(token.data);
        }
        if (generation === this.#processGeneration) {
            this.#syncBuffer();
        }
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
        graphics: {
            count: 0,
            protocols: [],
            revision: 0
        },
        lines: [],
        modes: {
            applicationCursorKeys: false,
            applicationKeypad: false,
            bracketedPaste: false,
            mouseEncoding: "legacy",
            mouseTracking: "none",
            sendFocus: false
        },
        rows: clampDimension(rows),
        scroll: {
            atBottom: true,
            historyLines: 0,
            offsetFromBottom: 0,
            viewportLine: 0
        },
        status: "idle"
    };
}

function clampDimension(value: number): number {
    return Math.max(1, Math.floor(value));
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
