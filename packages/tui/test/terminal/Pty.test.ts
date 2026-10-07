import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalAttachment, TerminalSessionDescriptor, TerminalStreamMessage, TerminalVersionedIdentity } from "@portable-devshell/shared";
import type { TerminalStreamCommandIdentity } from "@portable-devshell/shared/testing";
import {
    TuiControlTerminalPtyFactory,
    type TuiControlTerminalClient,
} from "../../src/terminal/control/Pty.ts";
import { TuiKeyDispatcher } from "../../src/interaction/Input.js";

{
    class FakeAttachment {
        readonly sent: Array<{ operation: string; payload: unknown }> = [];
        closed = false;
        readonly #messages: TerminalStreamMessage[] = [];
        readonly #waiters: Array<(message: TerminalStreamMessage) => void> = [];

        ack(
            identity: TerminalVersionedIdentity,
            throughSeq: number,
        ): Promise<void> {
            this.sent.push({
                operation: "ack",
                payload: {
                    generation: identity.generation,
                    terminalId: identity.terminalId,
                    throughSeq,
                    version: identity.version,
                },
            });
            return Promise.resolve();
        }

        close(): void {
            this.closed = true;
            this.push({ kind: "closed" });
        }

        next(): Promise<TerminalStreamMessage> {
            const message = this.#messages.shift();
            if (message !== undefined) return Promise.resolve(message);
            return new Promise((resolve) => this.#waiters.push(resolve));
        }

        sendInput(
            data: string,
            command: TerminalStreamCommandIdentity,
        ): Promise<void> {
            this.sent.push({
                operation: "input",
                payload: { ...command, data },
            });
            return Promise.resolve();
        }

        sendResize(
            cols: number,
            rows: number,
            command: TerminalStreamCommandIdentity,
        ): Promise<void> {
            this.sent.push({
                operation: "resize",
                payload: { ...command, cols, rows },
            });
            return Promise.resolve();
        }

        push(message: TerminalStreamMessage): void {
            const waiter = this.#waiters.shift();
            if (waiter === undefined) this.#messages.push(message);
            else waiter(message);
        }

        asTerminalAttachment(): TerminalAttachment {
            return this as unknown as TerminalAttachment;
        }
    }

    function attachAttachment(
        attachment: FakeAttachment,
        session: TerminalSessionDescriptor,
    ): TerminalAttachment {
        attachment.push({ kind: "seed", session });
        return attachment.asTerminalAttachment();
    }

    test("control terminal PTY waits for versioned acknowledgements and resumes by output sequence", async () => {
        const stream = new FakeAttachment();
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
            async attach(input) {
                attachCalls.push(input);
                return attachAttachment(stream, {
                    ...opened,
                    latestSeq: input.fromSeq,
                });
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
            client: () => client,
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
        stream.push({ kind: "output", frame: { data: "hello", seq: 1 } });
        await waitFor(() => output.includes("hello"));

        await waitFor(() =>
            stream.sent.some((entry) => entry.operation === "ack"),
        );
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
        stream.push({
            kind: "inputAccepted",
            clientSeq: 1,
            identity: {
                generation: 3,
                terminalId: "terminal-1",
                version: 1,
            },
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
        stream.push({
            kind: "resized",
            clientSeq: 2,
            identity: {
                generation: 3,
                terminalId: "terminal-1",
                version: 2,
            },
        });
        await waitFor(() => factory.snapshot("alpha")?.version === 2);

        pty.kill();
        assert.equal(stream.closed, true);

        const resumedStream = new FakeAttachment();
        client.attach = async (input) => {
            attachCalls.push(input);
            return attachAttachment(resumedStream, {
                ...opened,
                latestSeq: input.fromSeq,
                version: 2,
            });
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
        resumedStream.push({ kind: "output", frame: { data: "hello", seq: 1 } });
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
        const stream = new FakeAttachment();
        const client: TuiControlTerminalClient = {
            async attach() {
                return attachAttachment(stream, {
                    cols: 80,
                    createdAt: "2026-08-06T00:00:00.000Z",
                    generation: 1,
                    instance: "alpha",
                    latestSeq: 0,
                    rows: 24,
                    state: "running",
                    terminalId: "terminal-unknown",
                    version: 1,
                });
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
            client: () => client,
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
        const stream = new FakeAttachment();
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
                return attachAttachment(stream, { ...opened });
            },
            async kill() {
                throw new Error("not used");
            },
            async open() {
                return opened;
            },
        };
        const factory = new TuiControlTerminalPtyFactory({
            client: () => client,
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

        stream.push({ kind: "exit", event: { exitCode: 0, signal: 0 } });
        stream.push({
            kind: "closed",
            session: {
                ...opened,
                state: "exited",
                version: 7,
            },
        });

        await waitFor(() => factory.snapshot("alpha")?.version === 7);
        assert.equal(factory.snapshot("alpha")?.state, "exited");
        assert.deepEqual(exits, [0]);
    });

    test("control terminal kill uses versioned identity without overwriting a replacement session", async () => {
        const oldStream = new FakeAttachment();
        const newStream = new FakeAttachment();
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
            async attach(input) {
                return attachAttachment(currentStream, {
                    ...currentOpen,
                    latestSeq: input.fromSeq,
                });
            },
            async kill(identity) {
                killInputs.push(identity);
                return await killResult;
            },
            async open() {
                return currentOpen;
            },
        };
        const factory = new TuiControlTerminalPtyFactory({
            client: () => client,
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
        oldStream.push({ kind: "exit", event: { exitCode: 0, signal: 0 } });
        oldStream.push({
            kind: "closed",
            session: {
                ...oldSession,
                state: "exited",
                version: 2,
            },
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
}

{
    test("terminal kill shortcut is available only after leaving raw terminal input", () => {
        const dispatcher = new TuiKeyDispatcher();

        assert.deepEqual(
            dispatcher.dispatch("sidebarContext", {
                input: "K",
                key: { shift: true },
            }),
            [{ type: "terminal.requestKill" }],
        );
        assert.deepEqual(
            dispatcher.dispatch("terminal", {
                input: "K",
                key: { shift: true },
            }),
            [],
        );
    });
}
