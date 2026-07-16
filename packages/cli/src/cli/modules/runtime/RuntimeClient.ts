import {
    instanceClientModule,
    type ClientConnection,
    type InstanceLogEntry,
    type InstanceRuntimeEnvelope,
    type InstanceSnapshot,
    type JsonValue,
    type PrefixRoute
} from "@portable-devshell/shared";

import { clientEventStream, type ClientEventStream } from "../../client/ClientEventStream.js";

export interface TerminalRelay {
    input: NodeJS.ReadableStream;
    output: { write(chunk: string): void };
}

export function createRuntimeClient(connection: ClientConnection) {
    const runtime = instanceClientModule(connection, "runtime");
    return {
        snapshot: (instance: string): Promise<InstanceRuntimeEnvelope> => runtime.request(instance, "snapshot"),
        refresh: (instance: string): Promise<InstanceRuntimeEnvelope> => runtime.request(instance, "refresh"),
        stop: (instance: string): Promise<InstanceSnapshot> => runtime.request(instance, "stop"),
        readLogs: (
            instance: string,
            query?: { fromSeq?: number; limit?: number }
        ): Promise<InstanceLogEntry[]> => runtime.request(instance, "readLogs", query),
        subscribe: async (instance: string, fromSeq: number): Promise<ClientEventStream> =>
            clientEventStream(instance, await runtime.openStream(instance, "subscribe", { fromSeq })),
        start: async (instance: string, relay?: TerminalRelay): Promise<InstanceSnapshot> => {
            const restoreTerminal = relay === undefined ? () => undefined : enableRawRelayMode(relay.input);
            let cleanupInput: () => void = () => undefined;
            let route: PrefixRoute | undefined;
            try {
                const opened = await runtime.openStream(instance, "start");
                route = opened.route;
                if (relay !== undefined) {
                    cleanupInput = attachRelayInput(relay.input, route, opened.acknowledgement.event.destination);
                }
                while (true) {
                    const event = (await route.nextStreamFrame()).event;
                    if (event.name === "runtime.output") {
                        if (relay !== undefined && isRecord(event.payload) && typeof event.payload.chunk === "string") {
                            relay.output.write(event.payload.chunk);
                        }
                        continue;
                    }
                    if (event.name === "stream.completed") {
                        return event.payload as unknown as InstanceSnapshot;
                    }
                    if (event.name === "stream.cancelled") {
                        connection.throwRemoteError(event.error);
                        throw new Error("Interactive start was cancelled.");
                    }
                }
            } catch (error) {
                throw connection.mapError(error);
            } finally {
                cleanupInput();
                restoreTerminal();
                route?.close();
            }
        }
    };
}

export type RuntimeClient = ReturnType<typeof createRuntimeClient>;

function attachRelayInput(
    input: NodeJS.ReadableStream,
    route: PrefixRoute,
    destination: import("@portable-devshell/shared").Destination
): () => void {
    const onData = (chunk: string | Buffer) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        void route.sendStream({
            destination,
            name: "runtime.input",
            payload: { data: value.toString("base64") }
        });
    };
    const onEnd = () => {
        void route.sendStream({ destination, name: "runtime.eof" });
    };
    input.on("data", onData);
    input.once("end", onEnd);
    return () => {
        input.off("data", onData);
        input.off("end", onEnd);
    };
}

function enableRawRelayMode(input: NodeJS.ReadableStream): () => void {
    if (!isRawModeCapable(input) || input.isTTY !== true) {
        return () => undefined;
    }
    const previous = input.isRaw;
    input.setRawMode(true);
    return () => input.setRawMode(previous === true);
}

function isRawModeCapable(
    input: NodeJS.ReadableStream
): input is NodeJS.ReadableStream & { isRaw?: boolean; isTTY?: boolean; setRawMode(mode: boolean): void } {
    return typeof input === "object" && input !== null && "setRawMode" in input && typeof input.setRawMode === "function";
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
