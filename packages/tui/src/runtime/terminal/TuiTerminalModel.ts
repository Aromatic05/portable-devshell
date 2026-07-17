import type { TuiAttachShellCommand } from "../attach/TuiAttachShellModel.js";

export interface TuiTerminalDisposable {
    dispose(): void;
}

export interface TuiTerminalSegment {
    backgroundColor?: string;
    bold?: boolean;
    color?: string;
    dimColor?: boolean;
    inverse?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    text: string;
    underline?: boolean;
}

export interface TuiTerminalLine {
    segments: TuiTerminalSegment[];
}

export interface TuiTerminalBufferSnapshot {
    columns: number;
    cursor: { x: number; y: number };
    lines: TuiTerminalLine[];
    rows: number;
    title?: string;
}

export type TuiTerminalStatus = "idle" | "starting" | "running" | "exited" | "error";

export interface TuiTerminalSnapshot extends TuiTerminalBufferSnapshot {
    error?: string;
    exitCode?: number;
    instance?: string;
    message?: string;
    status: TuiTerminalStatus;
}

export interface TuiTerminalPty {
    kill(): void;
    onData(listener: (data: string) => void): TuiTerminalDisposable;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): TuiTerminalDisposable;
    resize(columns: number, rows: number): void;
    write(data: string): void;
}

export interface TuiTerminalPtyOptions {
    columns: number;
    cwd?: string;
    environment: Record<string, string>;
    rows: number;
}

export type TuiTerminalPtyFactory = (
    command: string,
    args: readonly string[],
    options: TuiTerminalPtyOptions
) => TuiTerminalPty;

export interface TuiTerminalStartOptions {
    columns: number;
    command: TuiAttachShellCommand;
    environment?: NodeJS.ProcessEnv;
    instance: string;
    rows: number;
}
