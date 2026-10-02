// Terminal wire contract. RPC operations plus the attach stream message names
// and client command payloads.

import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { InstanceStreamEnvelope } from "../activity/Contract.js";
import type {
    TerminalExitEvent,
    TerminalOpenInput,
    TerminalOpenResult,
    TerminalOutputFrame,
    TerminalSessionDescriptor,
    TerminalSessionState,
    TerminalStreamMessage,
    TerminalVersionedIdentity,
} from "./Model.js";

export const terminalOperations = {
    attach: "attach",
    get: "get",
    kill: "kill",
    list: "list",
    open: "open",
} as const;

export interface TerminalContract {
    get: {
        request: Pick<TerminalVersionedIdentity, "generation" | "terminalId">;
        response: TerminalSessionDescriptor;
    };
    kill: {
        request: TerminalVersionedIdentity;
        response: TerminalSessionDescriptor;
    };
    list: {
        request: undefined;
        response: TerminalSessionDescriptor[];
    };
    open: {
        request: TerminalOpenInput;
        response: TerminalOpenResult;
    };
}

export type TerminalOperation = keyof TerminalContract;

export type TerminalRequest<Operation extends TerminalOperation> =
    TerminalContract[Operation]["request"];

export type TerminalResponse<Operation extends TerminalOperation> =
    TerminalContract[Operation]["response"];

export function readTerminalStreamMessage(
    envelope: InstanceStreamEnvelope,
): TerminalStreamMessage | undefined {
    const payload: Record<string, JsonValue> =
        record(envelope.payload) ?? {};
    if (envelope.name === "seed") {
        const session = payload === undefined ? undefined : payload.session;
        return session === undefined
            ? undefined
            : { kind: "seed", session: readTerminalSession(session) };
    }
    if (envelope.name === "output") {
        return {
            frame: readTerminalOutput(envelope.payload),
            kind: "output",
        };
    }
    if (envelope.name === "inputAccepted" || envelope.name === "resized") {
        return {
            clientSeq: readInteger(payload, "clientSeq"),
            identity: readTerminalIdentity(payload),
            kind: envelope.name,
        };
    }
    if (envelope.name === "exit") {
        return { event: readTerminalExit(envelope.payload), kind: "exit" };
    }
    return undefined;
}

export function readTerminalSession(value: unknown): TerminalSessionDescriptor {
    const payload = readRecord(value);
    return {
        cols: readInteger(payload, "cols"),
        createdAt: readString(payload, "createdAt"),
        generation: readInteger(payload, "generation"),
        instance: readString(payload, "instance"),
        latestSeq: readInteger(payload, "latestSeq"),
        rows: readInteger(payload, "rows"),
        state: readState(payload.state),
        terminalId: readString(payload, "terminalId"),
        version: readInteger(payload, "version"),
    };
}

export function readTerminalOutput(
    value: JsonValue | undefined,
): TerminalOutputFrame {
    const payload = readRecord(value);
    return {
        data: readString(payload, "data"),
        seq: readInteger(payload, "seq"),
    };
}

export function readTerminalExit(value: JsonValue | undefined): TerminalExitEvent {
    const payload = readRecord(value);
    const signal = payload.signal;
    return {
        exitCode: readInteger(payload, "exitCode"),
        ...(typeof signal === "number" ? { signal } : {}),
    };
}

export function readTerminalIdentity(
    value: Record<string, unknown>,
): TerminalVersionedIdentity {
    return {
        generation: readInteger(value, "generation"),
        terminalId: readString(value, "terminalId"),
        version: readInteger(value, "version"),
    };
}

export function readTerminalRecord(
    value: unknown,
): Record<string, unknown> {
    return readRecord(value);
}

function readRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Terminal payload must be an object.");
    return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, field: string): string {
    if (typeof value[field] !== "string")
        throw new Error(`Terminal ${field} must be a string.`);
    return value[field];
}

function readInteger(value: Record<string, unknown>, field: string): number {
    if (
        typeof value[field] !== "number" ||
        !Number.isSafeInteger(value[field])
    )
        throw new Error(`Terminal ${field} must be a safe integer.`);
    return value[field];
}

function readState(value: unknown): TerminalSessionState {
    if (
        value !== "running" &&
        value !== "exited" &&
        value !== "killed" &&
        value !== "lost" &&
        value !== "failed"
    ) {
        throw new Error("Terminal state is invalid.");
    }
    return value;
}

function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
