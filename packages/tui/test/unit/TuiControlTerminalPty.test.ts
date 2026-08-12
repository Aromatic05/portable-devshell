import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ClientEvent,
    type TerminalSessionDescriptor,
} from "@portable-devshell/shared";

import {
    TuiControlTerminalPtyFactory,
    type TuiControlTerminalClient,
    type TuiControlTerminalStream,
    type TuiOpenedTerminalStream,
} from "../../src/runtime/terminal/TuiControlTerminalPty.ts";

class FakeStream implements TuiControlTerminalStream {
    readonly id = "stream-1";
    readonly sent: Array<{ operation: string; payload: unknown }> = [];
    closed = false;
    readonly #events: ClientEvent[] = [];
    readonly #waiters: Array<(event: ClientEvent) => void> = [];

    close(): void {
        this.closed = true;
    }

    async nextEvent(): Promise<ClientEvent> {
        return (
            this.#events.shift() ??
            (await new Promise((resolve) => this.#waiters.push(resolve)))
        );
    }

    async send(operation: string, payload?: unknown): Promise<void> {
        this.sent.push({ operation, payload });
    }

    emit(name: ClientEvent["name"], payload?: unknown): void {
        const event = {
            destination: asInstanceName("alpha"),
            id: `event-${this.#events.length}`,
            name,
            ...(payload === undefined ? {} : { payload }),
            streamId: this.id,
        } as ClientEvent;
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#events.push(event);
        else waiter(event);
    }
}

test("control terminal PTY waits for versioned acknowledgements and resumes by output sequence", async () => {
    const stream = new FakeStream();
    const opened: TerminalSessionDescriptor = {
        cols: 80,
        createdAt: "2026-08-06T00:00:00.000Z",
        generation: 3,
        instance: "alpha",
        latestSeq: 0,
        rows: 24,
        state: "running",
        terminalId: "terminal-1",
        version: 1,
    };
    const attachCalls: unknown[] = [];
    let openCalls = 0;
    const client: TuiControlTerminalClient = {
        async attach(_instance, input): Promise<TuiOpenedTerminalStream> {
            attachCalls.push(input);
            return {
                acknowledgement: {
                    destination: asInstanceName("alpha"),
                    id: "ack",
                    name: "terminal.attach",
                    payload: {
                        session: { ...opened, latestSeq: input.fromSeq },
                    },
                    replyTo: "request",
                    streamId: stream.id,
                },
                stream,
            };
        },
        async kill() {
            throw new Error("detach must not kill the terminal");
        },
        async open() {
            openCalls += 1;
            return opened;
        },
    };
    const factory = new TuiControlTerminalPtyFactory({
        client,
        workspaceForInstance: () => "/home/alpha",
    });
    const pty = factory.create("alpha")("ignored", [], {
        columns: 80,
        environment: {},
        rows: 24,
    });
    const output: string[] = [];
    pty.onData((data) => output.push(data));

    await waitFor(() => attachCalls.length === 1);
    assert.equal(openCalls, 1);
    stream.emit("terminal.output", { data: "hello", seq: 1 });
    await waitFor(() => output.includes("hello"));

    await waitFor(() => stream.sent.some((entry) => entry.operation === "ack"));
    pty.write("pwd\r");
    await waitFor(() =>
        stream.sent.some((entry) => entry.operation === "input"),
    );
    assert.deepEqual(
        stream.sent.find((entry) => entry.operation === "input"),
        {
            operation: "input",
            payload: {
                clientSeq: 1,
                data: "pwd\r",
                generation: 3,
                terminalId: "terminal-1",
                version: 1,
            },
        },
    );
    stream.emit("terminal.inputAccepted", {
        clientSeq: 1,
        generation: 3,
        terminalId: "terminal-1",
        version: 1,
    });

    pty.resize(100, 40);
    await waitFor(() =>
        stream.sent.some((entry) => entry.operation === "resize"),
    );
    assert.deepEqual(
        stream.sent.find((entry) => entry.operation === "resize"),
        {
            operation: "resize",
            payload: {
                clientSeq: 2,
                cols: 100,
                generation: 3,
                rows: 40,
                terminalId: "terminal-1",
                version: 1,
            },
        },
    );
    stream.emit("terminal.resized", {
        clientSeq: 2,
        generation: 3,
        terminalId: "terminal-1",
        version: 2,
    });
    await waitFor(() => factory.snapshot("alpha")?.version === 2);

    pty.kill();
    assert.equal(stream.closed, true);

    const resumedStream = new FakeStream();
    client.attach = async (_instance, input) => {
        attachCalls.push(input);
        return {
            acknowledgement: {
                destination: asInstanceName("alpha"),
                id: "ack-2",
                name: "terminal.attach",
                payload: { session: { ...opened, latestSeq: 1, version: 2 } },
                replyTo: "request-2",
                streamId: resumedStream.id,
            },
            stream: resumedStream,
        };
    };
    const resumed = factory.create("alpha")("ignored", [], {
        columns: 100,
        environment: {},
        rows: 40,
    });
    const resumedOutput: string[] = [];
    resumed.onData((data) => resumedOutput.push(data));
    await waitFor(() => attachCalls.length === 2);
    assert.equal(openCalls, 1);
    assert.deepEqual(attachCalls[1], {
        fromSeq: 0,
        generation: 3,
        terminalId: "terminal-1",
    });
    resumedStream.emit("terminal.output", { data: "hello", seq: 1 });
    await waitFor(() => resumedOutput.includes("hello"));
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error("Timed out waiting for terminal state.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test("control terminal PTY reports result unknown instead of replaying unacknowledged input", async () => {
    const stream = new FakeStream();
    const client: TuiControlTerminalClient = {
        async attach() {
            return {
                acknowledgement: {
                    destination: asInstanceName("alpha"),
                    id: "ack-unknown",
                    name: "terminal.attach",
                    payload: {
                        session: {
                            cols: 80,
                            createdAt: "2026-08-06T00:00:00.000Z",
                            generation: 1,
                            instance: "alpha",
                            latestSeq: 0,
                            rows: 24,
                            state: "running",
                            terminalId: "terminal-unknown",
                            version: 1,
                        },
                    },
                    replyTo: "request-unknown",
                    streamId: stream.id,
                },
                stream,
            };
        },
        async kill() {
            throw new Error("not used");
        },
        async open() {
            return {
                cols: 80,
                createdAt: "2026-08-06T00:00:00.000Z",
                generation: 1,
                instance: "alpha",
                latestSeq: 0,
                rows: 24,
                state: "running",
                terminalId: "terminal-unknown",
                version: 1,
            };
        },
    };
    const pty = new TuiControlTerminalPtyFactory({
        client,
        operationAckTimeoutMs: 20,
        workspaceForInstance: () => "/home/alpha",
    }).create("alpha")("ignored", [], {
        columns: 80,
        environment: {},
        rows: 24,
    });
    const output: string[] = [];
    const exits: number[] = [];
    pty.onData((data) => output.push(data));
    pty.onExit((event) => exits.push(event.exitCode));

    pty.write("destructive-operation\r");
    await waitFor(() =>
        output.some((line) => line.includes("result is unknown")),
    );

    assert.equal(
        stream.sent.filter((entry) => entry.operation === "input").length,
        1,
    );
    assert.deepEqual(exits, [1]);
});

test("control terminal PTY keeps the authoritative completed session version", async () => {
    const stream = new FakeStream();
    const opened: TerminalSessionDescriptor = {
        cols: 80,
        createdAt: "2026-08-06T00:00:00.000Z",
        generation: 4,
        instance: "alpha",
        latestSeq: 0,
        rows: 24,
        state: "running",
        terminalId: "terminal-completed",
        version: 2,
    };
    const client: TuiControlTerminalClient = {
        async attach() {
            return {
                acknowledgement: {
                    destination: asInstanceName("alpha"),
                    id: "ack-completed",
                    name: "terminal.attach",
                    payload: { session: { ...opened } },
                    replyTo: "request-completed",
                    streamId: stream.id,
                },
                stream,
            };
        },
        async kill() {
            throw new Error("not used");
        },
        async open() {
            return opened;
        },
    };
    const factory = new TuiControlTerminalPtyFactory({
        client,
        workspaceForInstance: () => "/home/alpha",
    });
    const pty = factory.create("alpha")("ignored", [], {
        columns: 80,
        environment: {},
        rows: 24,
    });
    const exits: number[] = [];
    pty.onExit((event) => exits.push(event.exitCode));
    await waitFor(() => factory.snapshot("alpha") !== undefined);

    stream.emit("terminal.exit", { exitCode: 0, signal: 0 });
    stream.emit("stream.completed", {
        ...opened,
        state: "exited",
        version: 7,
    });

    await waitFor(() => factory.snapshot("alpha")?.version === 7);
    assert.equal(factory.snapshot("alpha")?.state, "exited");
    assert.deepEqual(exits, [0]);
});

test("control terminal kill uses versioned identity without overwriting a replacement session", async () => {
    const oldStream = new FakeStream();
    const newStream = new FakeStream();
    const oldSession: TerminalSessionDescriptor = {
        cols: 80,
        createdAt: "2026-08-06T00:00:00.000Z",
        generation: 1,
        instance: "alpha",
        latestSeq: 0,
        rows: 24,
        state: "running",
        terminalId: "terminal-old",
        version: 1,
    };
    const newSession: TerminalSessionDescriptor = {
        ...oldSession,
        generation: 2,
        terminalId: "terminal-new",
    };
    let currentOpen = oldSession;
    let currentStream = oldStream;
    let releaseKill!: () => void;
    const killResult = new Promise<TerminalSessionDescriptor>((resolve) => {
        releaseKill = () =>
            resolve({ ...oldSession, state: "killed", version: 2 });
    });
    const killInputs: unknown[] = [];
    const client: TuiControlTerminalClient = {
        async attach(_instance, input) {
            return {
                acknowledgement: {
                    destination: asInstanceName("alpha"),
                    id: `ack-${currentOpen.terminalId}`,
                    name: "terminal.attach",
                    payload: {
                        session: { ...currentOpen, latestSeq: input.fromSeq },
                    },
                    replyTo: "request",
                    streamId: currentStream.id,
                },
                stream: currentStream,
            };
        },
        async kill(_instance, identity) {
            killInputs.push(identity);
            return await killResult;
        },
        async open() {
            return currentOpen;
        },
    };
    const factory = new TuiControlTerminalPtyFactory({
        client,
        workspaceForInstance: () => "/home/alpha",
    });
    factory.create("alpha")("ignored", [], {
        columns: 80,
        environment: {},
        rows: 24,
    });
    await waitFor(
        () => factory.snapshot("alpha")?.terminalId === "terminal-old",
    );

    const killing = factory.kill("alpha");
    oldStream.emit("terminal.exit", { exitCode: 0, signal: 0 });
    oldStream.emit("stream.completed", {
        ...oldSession,
        state: "exited",
        version: 2,
    });
    await waitFor(() => factory.snapshot("alpha")?.state === "exited");
    currentOpen = newSession;
    currentStream = newStream;
    factory.create("alpha")("ignored", [], {
        columns: 80,
        environment: {},
        rows: 24,
    });
    await waitFor(
        () => factory.snapshot("alpha")?.terminalId === "terminal-new",
    );

    releaseKill();
    await killing;

    assert.deepEqual(killInputs, [
        {
            generation: 1,
            terminalId: "terminal-old",
            version: 1,
        },
    ]);
    assert.equal(factory.snapshot("alpha")?.terminalId, "terminal-new");
});
