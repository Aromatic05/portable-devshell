import {
    instanceClientModule,
    type ClientConnection,
    type ClientStream,
    type InstanceLogEntry,
    type InstanceRuntimeEnvelope,
    type InstanceSnapshot,
    type JsonValue
} from "@portable-devshell/shared";

import { createTuiClientRuntimeStream, type TuiClientRuntimeStream } from "./TuiClientRuntimeStream.js";

export interface TuiClientRuntimeStartOptions {
    relay?: {
        onOutput(chunk: string): void;
        onRequestId?(requestId: string): void;
    };
    workspacePath?: string;
}

export function createTuiClientRuntime(connection: ClientConnection) {
    const runtime = instanceClientModule(connection, "runtime");
    return {
        snapshot: (instance: string): Promise<InstanceRuntimeEnvelope> => runtime.request(instance, "snapshot"),
        refresh: (instance: string): Promise<InstanceRuntimeEnvelope> => runtime.request(instance, "refresh"),
        stop: (instance: string): Promise<InstanceSnapshot> => runtime.request(instance, "stop"),
        readLogs: (
            instance: string,
            params?: { fromSeq?: number; limit?: number }
        ): Promise<InstanceLogEntry[]> => runtime.request(instance, "readLogs", params),
        subscribe: async (instance: string, fromSeq: number): Promise<TuiClientRuntimeStream> =>
            createTuiClientRuntimeStream(instance, await runtime.openStream(instance, "subscribe", { fromSeq })),
        start: async (instance: string, options: TuiClientRuntimeStartOptions = {}): Promise<InstanceSnapshot> => {
            let stream: ClientStream | undefined;
            try {
                const opened = await runtime.openStream(
                    instance,
                    "start",
                    options.workspacePath === undefined ? undefined : { workspacePath: options.workspacePath }
                );
                stream = opened.stream;
                options.relay?.onRequestId?.(stream.id);
                while (true) {
                    const event = await stream.nextEvent();
                    if (event.name === "runtime.output") {
                        if (isRecord(event.payload) && typeof event.payload.chunk === "string") {
                            options.relay?.onOutput(event.payload.chunk);
                        }
                        continue;
                    }
                    if (event.name === "stream.completed") {
                        return event.payload as unknown as InstanceSnapshot;
                    }
                    if (event.name === "stream.cancelled") {
                        connection.throwRemoteError(event.error);
                        throw Object.assign(new Error("Interactive start was cancelled."), {
                            code: "control.requestFailed"
                        });
                    }
                }
            } catch (error) {
                throw connection.mapError(error);
            } finally {
                stream?.close();
            }
        }
    };
}

export type TuiClientRuntime = ReturnType<typeof createTuiClientRuntime>;

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
