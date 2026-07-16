import {
    instanceClientModule,
    type ClientConnection,
    type InstanceLogEntry,
    type InstanceRuntimeEnvelope,
    type InstanceSnapshot,
    type JsonValue,
    type PrefixRoute
} from "@portable-devshell/shared";

import { runtimeStream, type RuntimeStream } from "./RuntimeStream.js";

export interface RuntimeStartOptions {
    relay?: {
        onOutput(chunk: string): void;
        onRequestId?(requestId: string): void;
    };
    workspacePath?: string;
}

export function createRuntimeClient(connection: ClientConnection) {
    const runtime = instanceClientModule(connection, "runtime");
    return {
        snapshot: (instance: string): Promise<InstanceRuntimeEnvelope> => runtime.request(instance, "snapshot"),
        refresh: (instance: string): Promise<InstanceRuntimeEnvelope> => runtime.request(instance, "refresh"),
        stop: (instance: string): Promise<InstanceSnapshot> => runtime.request(instance, "stop"),
        readLogs: (
            instance: string,
            params?: { fromSeq?: number; limit?: number }
        ): Promise<InstanceLogEntry[]> => runtime.request(instance, "readLogs", params),
        subscribe: async (instance: string, fromSeq: number): Promise<RuntimeStream> =>
            runtimeStream(instance, await runtime.openStream(instance, "subscribe", { fromSeq })),
        start: async (instance: string, options: RuntimeStartOptions = {}): Promise<InstanceSnapshot> => {
            let route: PrefixRoute | undefined;
            try {
                const opened = await runtime.openStream(
                    instance,
                    "start",
                    options.workspacePath === undefined ? undefined : { workspacePath: options.workspacePath }
                );
                route = opened.route;
                options.relay?.onRequestId?.(opened.acknowledgement.streamId ?? opened.acknowledgement.replyTo ?? "");
                while (true) {
                    const event = (await route.nextStreamFrame()).event;
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
                route?.close();
            }
        }
    };
}

export type RuntimeClient = ReturnType<typeof createRuntimeClient>;

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
