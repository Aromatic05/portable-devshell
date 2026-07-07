import type { JsonValue } from "@portable-devshell/shared";

import type { CliControlConnection } from "./CliControlConnection.js";
import type { CliControlEventEnvelope } from "./CliControlRequest.js";

export class CliControlStream {
    readonly #connection: CliControlConnection;
    readonly #initialEvents: CliControlEventEnvelope[];

    constructor(connection: CliControlConnection, initialEvents: CliControlEventEnvelope[]) {
        this.#connection = connection;
        this.#initialEvents = initialEvents;
    }

    async nextEvent(): Promise<CliControlEventEnvelope> {
        const event = this.#initialEvents.shift();

        if (event !== undefined) {
            return event;
        }

        return await this.#connection.nextEvent();
    }

    close(): void {
        this.#connection.close();
    }
}

export interface CliInstanceSnapshotEnvelope {
    lastSeq: number;
    snapshot: {
        connectionState: string;
        daemonState: string;
        lastErrorCode?: string;
        lastSeq: number;
        name: string;
        pid?: number;
        ready: boolean;
        status: string;
    };
}

export interface CliInstanceListEntry {
    mcpEnabled: boolean;
    name: string;
    snapshot: CliInstanceSnapshotEnvelope["snapshot"];
}

export interface CliInstanceLogEntry {
    at: string;
    instanceName: string;
    message: string;
    seq: number;
    stream: "stderr" | "stdout";
}

export interface CliCommandResult {
    exitCode: number | null;
    signal?: string;
    stderr: string;
    stdout: string;
    timedOut?: boolean;
}

export function asInstanceSnapshotEnvelope(value: JsonValue): CliInstanceSnapshotEnvelope {
    return value as unknown as CliInstanceSnapshotEnvelope;
}

export function asInstanceList(value: JsonValue): CliInstanceListEntry[] {
    return value as unknown as CliInstanceListEntry[];
}

export function asLogEntries(value: JsonValue): CliInstanceLogEntry[] {
    return value as unknown as CliInstanceLogEntry[];
}

export function asCommandResult(value: JsonValue): CliCommandResult {
    return value as unknown as CliCommandResult;
}
