import {
    PROCESS_PORT,
    Stream,
    readInstanceSnapshot,
    type ControlStreamMessage,
    type Endpoint,
    type InstanceSnapshot,
    type MessageStream,
    type ProcessTransport,
} from "@portable-devshell/shared";

import { CliClientEventStream } from "./Client.js";

export interface CliClientRuntimeTerminalRelay {
    input: NodeJS.ReadableStream;
    output: { write(chunk: string): void };
}

export type CliClientRuntime = Omit<
    ProcessTransport,
    "start" | "subscribe"
> & {
    start(relay?: CliClientRuntimeTerminalRelay): Promise<InstanceSnapshot>;
    subscribe(fromSeq: number): Promise<CliClientEventStream>;
};

export function createCliRuntimeAdapter(
    endpoint: Endpoint,
    instance: string,
    runtime: ProcessTransport,
): CliClientRuntime {
    return {
        ...runtime,
        start: async (relay) => await startInteractive(endpoint, instance, relay),
        subscribe: async (fromSeq) =>
            new CliClientEventStream(await runtime.subscribe(fromSeq)),
    };
}

async function startInteractive(
    endpoint: Endpoint,
    instance: string,
    relay?: CliClientRuntimeTerminalRelay,
): Promise<InstanceSnapshot> {
    const protocol = new Stream(await endpoint.connect(instance, PROCESS_PORT));
    const stream = await protocol.open("start");
    const restoreTerminal =
        relay === undefined ? () => undefined : enableRawRelayMode(relay.input);
    const input = relay === undefined ? undefined : attachRelayInput(relay.input, stream);
    const offData = stream.onData((message) => {
        const event = message as ControlStreamMessage;
        if (event.name !== "output" || relay === undefined) return;
        const payload = event.payload;
        if (
            typeof payload === "object" &&
            payload !== null &&
            !Array.isArray(payload) &&
            typeof payload.chunk === "string"
        )
            relay.output.write(payload.chunk);
    });
    try {
        const completed = terminal(stream);
        return readInstanceSnapshot(
            (input === undefined
                ? await completed
                : await Promise.race([completed, input.failure])) as never,
        );
    } finally {
        offData();
        input?.cleanup();
        restoreTerminal();
        protocol.close();
    }
}

function attachRelayInput(
    input: NodeJS.ReadableStream,
    stream: MessageStream,
): { cleanup(): void; failure: Promise<never> } {
    let rejectFailure: (error: unknown) => void = () => undefined;
    const failure = new Promise<never>((_resolve, reject) => {
        rejectFailure = reject;
    });
    const send = (name: "input" | "eof", payload?: { data: string }) =>
        void stream.send({ name, ...(payload === undefined ? {} : { payload }) }).catch(rejectFailure);
    const onData = (chunk: string | Buffer) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        send("input", { data: value.toString("base64") });
    };
    const onEnd = () => send("eof");
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

function terminal(stream: MessageStream): Promise<unknown> {
    return new Promise((resolve, reject) => {
        stream.onClose(resolve);
        stream.onCancel((error) => reject(Object.assign(
            new Error(error?.message ?? "Stream cancelled."),
            error?.code === undefined ? {} : { code: error.code },
        )));
    });
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
    return (
        typeof input === "object" &&
        input !== null &&
        "setRawMode" in input &&
        typeof input.setRawMode === "function"
    );
}
