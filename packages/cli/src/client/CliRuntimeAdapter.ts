import {
    readInstanceSnapshot,
    type ClientConnection,
    type ClientStream,
    type ControlClients,
    type InstanceSnapshot,
} from "@portable-devshell/shared";

import { CliClientEventStream } from "./CliClientEventStream.js";

export interface CliClientRuntimeTerminalRelay {
    input: NodeJS.ReadableStream;
    output: { write(chunk: string): void };
}

export type CliClientRuntime = Omit<ControlClients["runtime"], "start" | "subscribe"> & {
    start(
        instance: string,
        relay?: CliClientRuntimeTerminalRelay,
    ): Promise<InstanceSnapshot>;
    subscribe(instance: string, fromSeq: number): Promise<CliClientEventStream>;
};

export function createCliRuntimeAdapter(
    connection: ClientConnection,
    runtime: ControlClients["runtime"],
): CliClientRuntime {
    return {
        ...runtime,
        start: async (instance, relay) =>
            await startInteractive(connection, runtime, instance, relay),
        subscribe: async (instance, fromSeq) =>
            new CliClientEventStream(
                await runtime.subscribe(instance, fromSeq),
            ),
    };
}

async function startInteractive(
    connection: ClientConnection,
    runtime: ControlClients["runtime"],
    instance: string,
    relay?: CliClientRuntimeTerminalRelay,
): Promise<InstanceSnapshot> {
    const restoreTerminal = relay === undefined
        ? () => undefined
        : enableRawRelayMode(relay.input);
    let cleanupInput: () => void = () => undefined;
    let stream: ClientStream | undefined;
    try {
        const opened = await runtime.openStart(instance);
        stream = opened.stream;
        if (relay !== undefined) {
            cleanupInput = attachRelayInput(relay.input, stream);
        }
        while (true) {
            const event = await stream.nextEvent();
            if (event.name === "runtime.output") {
                const payload = event.payload;
                if (
                    relay !== undefined &&
                    typeof payload === "object" &&
                    payload !== null &&
                    !Array.isArray(payload) &&
                    typeof payload.chunk === "string"
                ) {
                    relay.output.write(payload.chunk);
                }
                continue;
            }
            if (event.name === "stream.completed") {
                return readInstanceSnapshot(event.payload);
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
        stream?.close();
    }
}

function attachRelayInput(
    input: NodeJS.ReadableStream,
    stream: ClientStream,
): () => void {
    const onData = (chunk: string | Buffer) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        void stream.send("input", { data: value.toString("base64") });
    };
    const onEnd = () => {
        void stream.send("eof");
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
    input: NodeJS.ReadableStream,
): input is NodeJS.ReadableStream & {
    isRaw?: boolean;
    isTTY?: boolean;
    setRawMode(mode: boolean): void;
} {
    return typeof input === "object" &&
        input !== null &&
        "setRawMode" in input &&
        typeof input.setRawMode === "function";
}
