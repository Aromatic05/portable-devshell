import {
    Stream,
    type CliCommandTransport,
    type CliCommandWireResult,
    type ControlStreamMessage,
    type Endpoint,
    type JsonValue,
    type MessageStream,
} from "@portable-devshell/shared";

export interface CliCommandTerminalRelay {
    input: NodeJS.ReadableStream;
    stderr: { write(chunk: string): void };
    stdout: { write(chunk: string): void };
}

export interface CliClientCommandOptions {
    relay?: CliCommandTerminalRelay;
    signal?: AbortSignal;
    workingDirectory?: string;
}

export type CliClientCommand = Omit<CliCommandTransport, "command"> & {
    command(
        commandId: string,
        argv: readonly string[],
        options?: CliClientCommandOptions,
    ): Promise<CliCommandWireResult>;
};

export function createCliCommandAdapter(
    endpoint: Endpoint,
    cli: CliCommandTransport,
): CliClientCommand {
    return {
        command: (commandId, argv, options = {}) =>
            runCommandStream(endpoint, commandId, argv, options),
        commands: cli.commands,
    };
}

async function runCommandStream(
    endpoint: Endpoint,
    commandId: string,
    argv: readonly string[],
    options: CliClientCommandOptions,
): Promise<CliCommandWireResult> {
    const protocol = new Stream(await endpoint.connect("@control", "extension"));
    const stream = await protocol.open("cliCommandStream", {
        argv: [...argv],
        commandId,
        ...(options.workingDirectory === undefined
            ? {}
            : { workingDirectory: options.workingDirectory }),
    });
    let relay: InputRelay | undefined;
    const aborted = () =>
        void stream.cancel({ message: abortError(options.signal!, "CLI command was aborted.").message });
    options.signal?.addEventListener("abort", aborted, { once: true });
    try {
        while (true) {
            const next =
                relay === undefined
                    ? await stream.readMessage()
                    : await Promise.race([stream.readMessage(), relay.failure]);
            if (next.type === "close")
                return readCommandResult(next.message as JsonValue | undefined);
            if (next.type === "fin") continue;
            const event = next.message as ControlStreamMessage;
            if (event.name === "stdout" || event.name === "stderr") {
                const payload = record(event.payload);
                if (typeof payload?.chunk !== "string")
                    throw new Error(`Invalid ${event.name} payload.`);
                (event.name === "stdout"
                    ? options.relay?.stdout
                    : options.relay?.stderr
                )?.write(payload.chunk);
                continue;
            }
            if (event.name === "terminal") {
                const payload = record(event.payload);
                if (typeof payload?.raw !== "boolean")
                    throw new Error("Invalid terminal payload.");
                if (relay === undefined && options.relay !== undefined)
                    relay = attachInput(options.relay.input, stream, payload.raw);
            }
        }
    } finally {
        options.signal?.removeEventListener("abort", aborted);
        relay?.cleanup();
        protocol.close();
    }
}

interface InputRelay {
    cleanup(): void;
    failure: Promise<never>;
}

function attachInput(
    input: NodeJS.ReadableStream,
    stream: MessageStream,
    raw: boolean,
): InputRelay {
    const restoreTerminal = raw ? enableRawRelayMode(input) : () => undefined;
    let rejectFailure: (error: unknown) => void = () => undefined;
    const failure = new Promise<never>((_resolve, reject) => {
        rejectFailure = reject;
    });
    const send = (name: "input" | "eof", payload?: { data: string }) =>
        void stream
            .send({ name, ...(payload === undefined ? {} : { payload }) })
            .catch(rejectFailure);
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
            restoreTerminal();
        },
        failure,
    };
}

function enableRawRelayMode(input: NodeJS.ReadableStream): () => void {
    if (!isRawModeCapable(input) || input.isTTY !== true) return () => undefined;
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

function readCommandResult(value: JsonValue | undefined): CliCommandWireResult {
    const result = record(value);
    if (result?.kind === "text" && typeof result.text === "string")
        return { kind: "text", text: result.text };
    if (result?.kind === "json" && result.value !== undefined)
        return {
            kind: "json",
            ...(typeof result.text === "string" ? { text: result.text } : {}),
            value: result.value,
        };
    throw new Error("Invalid CLI command stream result.");
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function abortError(signal: AbortSignal, fallbackMessage: string): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(fallbackMessage);
}
