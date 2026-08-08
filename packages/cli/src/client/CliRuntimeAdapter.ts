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
    let relayFailure: Promise<never> | undefined;
    let stream: ClientStream | undefined;
    try {
        const opened = await runtime.openStart(instance);
        stream = opened.stream;
        if (relay !== undefined) {
            const attachment = attachRelayInput(relay.input, stream);
            cleanupInput = attachment.cleanup;
            relayFailure = attachment.failure;
        }
        const events = readInteractiveStartEvents(connection, stream, relay);
        return relayFailure === undefined
            ? await events
            : await Promise.race([events, relayFailure]);
    } catch (error) {
        throw connection.mapError(error);
    } finally {
        cleanupInput();
        restoreTerminal();
        stream?.close();
    }
}

async function readInteractiveStartEvents(
    connection: ClientConnection,
    stream: ClientStream,
    relay?: CliClientRuntimeTerminalRelay,
): Promise<InstanceSnapshot> {
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
}

function attachRelayInput(
    input: NodeJS.ReadableStream,
    stream: ClientStream,
): { cleanup(): void; failure: Promise<never> } {
    let failed = false;
    let rejectFailure: (error: unknown) => void = () => undefined;
    const failure = new Promise<never>((_resolve, reject) => {
        rejectFailure = reject;
    });
    const send = (operation: string, payload?: { data: string }) => {
        if (failed) return;
        void stream.send(operation, payload).catch((error: unknown) => {
            if (failed) return;
            failed = true;
            rejectFailure(error);
        });
    };
    const onData = (chunk: string | Buffer) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        send("input", { data: value.toString("base64") });
    };
    const onEnd = () => {
        send("eof");
    };
    input.on("data", onData);
    input.once("end", onEnd);
    return {
        cleanup() {
            input.off("data", onData);
            input.off("end", onEnd);
        },
        failure,
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
