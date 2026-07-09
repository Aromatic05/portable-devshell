import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { CliControlConnection } from "./CliControlConnection.js";
import type {
    CliControlEventEnvelope,
    CliControlStreamCancelledEnvelope,
    CliControlStreamGapEnvelope
} from "./CliControlRequest.js";

export type CliControlStreamMessage =
    | {
          envelope: CliControlEventEnvelope;
          kind: "instance.event";
      }
    | {
          envelope: CliControlStreamGapEnvelope;
          kind: "stream.gap";
      }
    | {
          envelope: CliControlStreamCancelledEnvelope;
          kind: "stream.cancelled";
      }
    | {
          kind: "connection.closed";
      };

export class CliControlStream {
    readonly #connection: CliControlConnection;
    readonly #initialMessages: CliControlStreamMessage[];
    #closed = false;

    constructor(connection: CliControlConnection, initialEvents: CliControlEventEnvelope[]) {
        this.#connection = connection;
        this.#initialMessages = initialEvents.map((event) => toStreamMessage(event));
    }

    async nextMessage(): Promise<CliControlStreamMessage> {
        if (this.#closed) {
            return {
                kind: "stream.cancelled",
                envelope: {
                    event: "stream.cancelled",
                    payload: {
                        instance: "",
                        reason: "client.closed"
                    },
                    seq: 0,
                    target: {
                        instance: "",
                        kind: "instance"
                    },
                    type: "event"
                }
            };
        }

        const event = this.#initialMessages.shift();

        if (event !== undefined) {
            return event;
        }

        return await this.#connection.nextStreamMessage();
    }

    async nextEvent(): Promise<CliControlEventEnvelope> {
        const message = await this.nextMessage();

        if (message.kind === "instance.event") {
            return message.envelope;
        }

        if (message.kind === "stream.gap") {
            throw createError({
                code: errorCodes.streamGap,
                message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: message.envelope.payload as unknown as JsonValue
            });
        }

        if (message.kind === "stream.cancelled") {
            throw new Error(`stream.cancelled:${message.envelope.payload.reason}`);
        }

        throw new Error("control connection closed");
    }

    close(): void {
        this.#closed = true;
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

function toStreamMessage(event: CliControlEventEnvelope): CliControlStreamMessage {
    if (event.event === "stream.gap") {
        return {
            envelope: event as CliControlStreamGapEnvelope,
            kind: "stream.gap"
        };
    }

    if (event.event === "stream.cancelled") {
        return {
            envelope: event as CliControlStreamCancelledEnvelope,
            kind: "stream.cancelled"
        };
    }

    return {
        envelope: event,
        kind: "instance.event"
    };
}
