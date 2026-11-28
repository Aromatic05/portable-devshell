import type { JsonValue } from "../../types/Json.js";

export type CodeLogLevel = "error" | "info" | "log" | "warn";

export interface CodeLogEntry {
    readonly level: CodeLogLevel;
    readonly text: string;
    readonly timestampMs: number;
}

export interface CodeEvalRequest {
    readonly filename?: string;
    readonly instance?: string;
    readonly source: string;
    readonly timeoutMs?: number;
    readonly workingDirectory?: string;
    readonly workspace?: string;
}

export interface CodeEvalMeta {
    readonly callId: string;
    readonly durationMs: number;
    readonly toolCalls: number;
    readonly truncatedLogs: boolean;
    readonly truncatedValue: boolean;
}

export interface CodeEvalResult {
    readonly hasValue: boolean;
    readonly logs: readonly CodeLogEntry[];
    readonly meta: CodeEvalMeta;
    readonly value?: JsonValue;
}

export interface CodeDescribeRequest {
    readonly filter?: string;
    readonly instance?: string;
    readonly target?: string;
}

export interface CodeDescribeResult {
    readonly dts: string;
    readonly namespaces: readonly string[];
}
