import type {
    ClientConnection,
    ClientStream,
    CliCommandWireResult,
    ControlClients,
    JsonValue
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

export type CliClientCommand = Omit<ControlClients["cli"], "command"> & {
    command(
        commandId: string,
        argv: readonly string[],
        options?: CliClientCommandOptions
    ): Promise<CliCommandWireResult>;
};

export function createCliCommandAdapter(
    connection: ClientConnection,
    cli: ControlClients["cli"]
): CliClientCommand {
    return {
        command: async (commandId, argv, options = {}) =>
            await runCommandStream(connection, commandId, argv, options),
        commands: cli.commands
    };
}

async function runCommandStream(
    connection: ClientConnection,
    commandId: string,
    argv: readonly string[],
    options: CliClientCommandOptions
): Promise<CliCommandWireResult> {
    let stream: ClientStream | undefined;
    let relay: InputRelay | undefined;
    try {
        const opened = await connection.openStream("@control", "cli", "commandStream", {
            argv: [...argv],
            commandId,
            ...(options.workingDirectory === undefined ? {} : {
                workingDirectory: options.workingDirectory
            })
        });
        stream = opened.stream;
        const aborted = () => stream?.close();
        options.signal?.addEventListener("abort", aborted, { once: true });
        try {
            if (options.signal?.aborted === true) {
                stream.close();
                throw abortError(options.signal, "CLI command was aborted.");
            }
            while (true) {
                const event = relay === undefined
                    ? await stream.nextEvent()
                    : await Promise.race([stream.nextEvent(), relay.failure]);
                if (event.name === "cli.stdout" || event.name === "cli.stderr") {
                    const payload = record(event.payload);
                    if (typeof payload?.chunk !== "string") {
                        throw new Error(`Invalid ${event.name} payload.`);
                    }
                    const output = event.name === "cli.stdout" ? options.relay?.stdout : options.relay?.stderr;
                    output?.write(payload.chunk);
                    continue;
                }
                if (event.name === "cli.terminal") {
                    const payload = record(event.payload);
                    if (typeof payload?.raw !== "boolean") {
                        throw new Error("Invalid cli.terminal payload.");
                    }
                    if (relay === undefined && options.relay !== undefined) {
                        relay = attachInput(options.relay.input, stream, payload.raw);
                    }
                    continue;
                }
                if (event.name === "stream.completed") {
                    return readCommandResult(event.payload);
                }
                if (event.name === "stream.cancelled") {
                    connection.throwRemoteError(event.error);
                    throw new Error("CLI command stream was cancelled.");
                }
            }
        } finally {
            options.signal?.removeEventListener("abort", aborted);
        }
    } catch (error) {
        throw connection.mapError(error);
    } finally {
        relay?.cleanup();
        stream?.close();
    }
}

interface InputRelay {
    cleanup(): void;
    failure: Promise<never>;
}

function attachInput(input: NodeJS.ReadableStream, stream: ClientStream, raw: boolean): InputRelay {
    const restoreTerminal = raw ? enableRawRelayMode(input) : () => undefined;
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
    const onEnd = () => send("eof");
    input.on("data", onData);
    input.once("end", onEnd);
    return {
        cleanup() {
            input.off("data", onData);
            input.off("end", onEnd);
            restoreTerminal();
        },
        failure
    };
}

function enableRawRelayMode(input: NodeJS.ReadableStream): () => void {
    if (!isRawModeCapable(input) || input.isTTY !== true) return () => undefined;
    const previous = input.isRaw;
    input.setRawMode(true);
    return () => input.setRawMode(previous === true);
}

function isRawModeCapable(
    input: NodeJS.ReadableStream
): input is NodeJS.ReadableStream & {
    isRaw?: boolean;
    isTTY?: boolean;
    setRawMode(mode: boolean): void;
} {
    return typeof input === "object"
        && input !== null
        && "setRawMode" in input
        && typeof input.setRawMode === "function";
}

function readCommandResult(value: JsonValue | undefined): CliCommandWireResult {
    const result = record(value);
    if (result?.kind === "text" && typeof result.text === "string") {
        return { kind: "text", text: result.text };
    }
    if (result?.kind === "json" && result.value !== undefined) {
        return { kind: "json", value: result.value };
    }
    throw new Error("Invalid CLI command stream result.");
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function abortError(signal: AbortSignal, fallbackMessage: string): Error {
    return signal.reason instanceof Error ? signal.reason : new Error(fallbackMessage);
}
