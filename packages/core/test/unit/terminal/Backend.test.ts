import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createRemoteError, TRANSPORT_RPC_RESULT_UNCERTAIN_CODE } from "@portable-devshell/shared";

import {
    WorkerTerminalBackend,
} from "../../../src/terminal/Backend.ts";
import type {
    TerminalProcessExit,
    WorkerTerminalAttachResult,
    WorkerTerminalDescriptor,
    WorkerTerminalIdentity,
    WorkerTerminalNotification,
    WorkerTerminalOpenInput,
    WorkerTerminalPort,
} from "../../../src/terminal/Api.ts";
import { TerminalSessionService } from "../../../src/terminal/Service.ts";

class FakeWorkerTerminal implements WorkerTerminalPort {
    readonly attaches: Array<Parameters<WorkerTerminalPort["attach"]>[0]> = [];
    readonly attachErrors: Error[] = [];
    readonly writes: Array<WorkerTerminalIdentity & { data: string }> = [];
    readonly resizes: Array<
        WorkerTerminalIdentity & { cols: number; rows: number }
    > = [];
    readonly kills: WorkerTerminalIdentity[] = [];
    notification?: (notification: WorkerTerminalNotification) => void;
    connected?: () => void;
    disconnected?: (error: Error) => void;
    attachExit?: { exitCode: number; signal: number };
    killError: Error | undefined;
    version = 1;
    latestSeq = 1;
    resizeGate?: Promise<void>;
    writeGate?: Promise<void>;

    descriptor(): WorkerTerminalDescriptor {
        return {
            cols: 80,
            createdAtMs: 1,
            generation: 9,
            latestSeq: this.latestSeq,
            rows: 24,
            state: "running",
            terminalId: "remote-terminal",
            version: this.version,
        };
    }

    async open(_input: WorkerTerminalOpenInput): Promise<WorkerTerminalDescriptor> {
        return this.descriptor();
    }

    async attach(
        input: Parameters<WorkerTerminalPort["attach"]>[0],
    ): Promise<WorkerTerminalAttachResult> {
        this.attaches.push(input);
        const error = this.attachErrors.shift();
        if (error !== undefined) throw error;
        const replay =
            input.fromSeq < this.latestSeq
                ? [
                      {
                          dataBase64: Buffer.from("replay").toString("base64"),
                          seq: this.latestSeq,
                      },
                  ]
                : [];
        return {
            ...(this.attachExit === undefined ? {} : { exit: this.attachExit }),
            replay,
            session:
                this.attachExit === undefined
                    ? this.descriptor()
                    : {
                          ...this.descriptor(),
                          state: "exited",
                          version: this.version + 1,
                      },
        };
    }

    async write(input: WorkerTerminalIdentity & { data: string }) {
        this.writes.push(input);
        await this.writeGate;
        return { ...input, accepted: true };
    }

    async resize(
        input: WorkerTerminalIdentity & { cols: number; rows: number },
    ) {
        this.resizes.push(input);
        await this.resizeGate;
        this.version += 1;
        return { ...input, accepted: true, version: this.version };
    }

    async kill(
        input: WorkerTerminalIdentity,
    ): Promise<WorkerTerminalDescriptor> {
        this.kills.push(input);
        if (this.killError !== undefined) throw this.killError;
        return {
            ...this.descriptor(),
            state: "exited",
            version: this.version + 1,
        };
    }

    async list(): Promise<WorkerTerminalDescriptor[]> {
        return [this.descriptor()];
    }

    onNotification(
        listener: (notification: WorkerTerminalNotification) => void,
    ): () => void {
        this.notification = listener;
        return () => {
            this.notification = undefined;
        };
    }

    onConnected(listener: () => void): () => void {
        this.connected = listener;
        return () => {
            this.connected = undefined;
        };
    }

    onDisconnected(listener: (error: Error) => void): () => void {
        this.disconnected = listener;
        return () => {
            this.disconnected = undefined;
        };
    }
}

class ControllableWorkerTerminal extends FakeWorkerTerminal {
    readonly controls: Array<Parameters<NonNullable<WorkerTerminalPort["control"]>>[0]> = [];
    controller?: string;
    acquireGate?: Promise<void>;
    releaseError?: Error;
    #nextController = 0;

    override descriptor(): WorkerTerminalDescriptor {
        return { ...super.descriptor(), humanControl: this.controller !== undefined };
    }

    control: NonNullable<WorkerTerminalPort["control"]> = async (input) => {
        this.controls.push(input);
        if (input.renew) {
            if (this.controller !== input.controller)
                throw createRemoteError({
                    code: "process.controlOwned",
                    message: "terminal input is controlled by another participant",
                    retryable: false,
                });
            return { renewed: true };
        }
        if (input.controller !== undefined) {
            if (this.releaseError !== undefined) throw this.releaseError;
            if (this.controller === input.controller) this.controller = undefined;
            return { released: true, session: this.descriptor() };
        }
        if (this.controller !== undefined)
            throw createRemoteError({
                code: "process.controlOwned",
                message: "terminal input is controlled by another participant",
                retryable: false,
            });
        const controller = `ctrl-${++this.#nextController}`;
        this.controller = controller;
        const session = this.descriptor();
        await this.acquireGate;
        return { controller, session, snapshot: { seq: session.latestSeq, data: "screen" } };
    };
}

async function openControllable(worker: ControllableWorkerTerminal) {
    const opened = await new WorkerTerminalBackend({ worker }).open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    assert.ok("process" in opened);
    return opened.process;
}

test("disconnect clears the attachment without announcing a remote handoff before reconnect", async (t) => {
    const worker = new ControllableWorkerTerminal();
    const released: string[] = [];
    const service = new TerminalSessionService({
        onControlReleased(session) { released.push(session.terminalId); },
    });
    t.after(() => service.close());
    const opened = await service.open({
        backend: new WorkerTerminalBackend({ worker }),
        cols: 80,
        instance: "alpha",
        rows: 24,
        workspace: "/workspace",
    });
    const attach = () => service.attach({
        fromSeq: 0,
        generation: opened.generation,
        onOutput() {},
        terminalId: opened.terminalId,
    });
    const previous = attach();
    const next = attach();
    await previous.takeControl();
    worker.disconnected!(new Error("transport closed"));
    assert.deepEqual(released, []);
    assert.equal(service.get(opened.terminalId).humanControl, true);

    worker.controller = undefined;
    worker.connected!();
    await setImmediate();
    assert.deepEqual(released, [opened.terminalId]);
    await next.takeControl();
    await next.write("pwd\r");
    assert.equal(worker.writes.at(-1)?.controller, "ctrl-2");
});

test("worker terminal backend drops stale control on an authoritative release notification", async () => {
    const worker = new ControllableWorkerTerminal();
    const process = await openControllable(worker);
    await process.acquireControl!();
    worker.controller = undefined;
    worker.notification?.({
        method: "terminal.control",
        params: {
            generation: 9,
            humanControl: false,
            terminalId: "remote-terminal",
            version: 2,
        },
    });
    await process.acquireControl!();
    await process.write("pwd\r");
    assert.equal(worker.writes.at(-1)?.controller, "ctrl-2");
});

test("a delayed release notification does not clear the new controller", async () => {
    const worker = new ControllableWorkerTerminal();
    const process = await openControllable(worker);
    await process.acquireControl!();
    await process.releaseControl!();
    await process.acquireControl!();
    worker.notification!({
        method: "terminal.control",
        params: { ...worker.descriptor(), humanControl: false },
    });
    await process.write("pwd\r");
    assert.equal(worker.writes.at(-1)?.controller, "ctrl-2");
    assert.equal(worker.controls.at(-1)?.renew, true);
    await process.releaseControl!();
});

test("a takeover response from the disconnected transport cannot install an old token", async () => {
    const worker = new ControllableWorkerTerminal();
    const process = await openControllable(worker);
    let resolveAcquire!: () => void;
    worker.acquireGate = new Promise<void>((resolve) => {
        resolveAcquire = resolve;
    });
    const acquiring = process.acquireControl!();
    await Promise.resolve();
    assert.equal(worker.controller, "ctrl-1");
    worker.disconnected!(new Error("transport closed"));
    worker.controller = undefined;
    worker.connected!();
    resolveAcquire();
    await assert.rejects(acquiring, /lease was lost during takeover/u);
    await process.acquireControl!();
    await process.write("pwd\r");
    assert.equal(worker.writes.at(-1)?.controller, "ctrl-2");
    await process.releaseControl!();
});

test("failed takeover recovery leaves no local token even if release also fails", async () => {
    const worker = new ControllableWorkerTerminal();
    const process = await openControllable(worker);
    const resumeFailure = new Error("resume failed");
    worker.latestSeq = 2;
    worker.attachErrors.push(resumeFailure);
    worker.releaseError = new Error("release failed");
    await assert.rejects(process.acquireControl!(), (error) => error === resumeFailure);
    worker.controller = undefined;
    worker.releaseError = undefined;
    await process.acquireControl!();
    await process.write("pwd\r");
    assert.equal(worker.writes.at(-1)?.controller, "ctrl-2");
    await process.releaseControl!();
});

const openAttachInput = {
    fromSeq: 0,
    generation: 9,
    terminalId: "remote-terminal",
};
const openAttachError = new Error("attach failed");

for (const { name, attachErrors, expectedAttaches, killError } of [
    {
        name: "the first attach fails",
        attachErrors: [openAttachError],
        expectedAttaches: [openAttachInput],
    },
    {
        name: "the snapshot retry fails",
        attachErrors: [
            Object.assign(new Error("stream gap"), { code: "stream.gap" }),
            openAttachError,
        ],
        expectedAttaches: [openAttachInput, { ...openAttachInput, restore: true }],
    },
    {
        name: "kill fails after attach fails",
        attachErrors: [openAttachError],
        expectedAttaches: [openAttachInput],
        killError: new Error("kill failed"),
    },
]) {
    test(`worker terminal backend cleans up failed open when ${name}`, async () => {
        const worker = new FakeWorkerTerminal();
        worker.attachErrors.push(...attachErrors);
        worker.killError = killError;
        const backend = new WorkerTerminalBackend({ worker });

        await assert.rejects(
            backend.open({ cols: 80, rows: 24, workspace: "/workspace" }),
            (error) => error === openAttachError,
        );
        assert.deepEqual(worker.attaches, expectedAttaches);
        assert.deepEqual(worker.kills, [
            {
                clientSeq: 1,
                generation: 9,
                terminalId: "remote-terminal",
                version: 1,
            },
        ]);
        assert.equal(worker.notification, undefined);
        assert.equal(worker.connected, undefined);
        assert.equal(worker.disconnected, undefined);
    });
}

test("worker terminal backend replays, fences async operations, and resumes after reconnect", async () => {
    const worker = new FakeWorkerTerminal();
    const backend = new WorkerTerminalBackend({ worker });
    const opened = await backend.open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    const process = "process" in opened ? opened.process : opened;
    const output: string[] = [];
    process.onData((data) => output.push(data));
    assert.deepEqual(output, ["replay"]);
    assert.deepEqual(worker.attaches, [
        {
            fromSeq: 0,
            generation: 9,
            terminalId: "remote-terminal",
        },
    ]);

    let releaseWrite!: () => void;
    worker.writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
    });
    let writeSettled = false;
    const writing = Promise.resolve(process.write("pwd\r")).then(() => {
        writeSettled = true;
    });
    await waitFor(() => worker.writes.length === 1);
    assert.equal(writeSettled, false);
    assert.equal(
        Buffer.from(worker.writes[0]!.data, "base64").toString(),
        "pwd\r",
    );
    releaseWrite();
    await writing;

    let releaseResize!: () => void;
    worker.resizeGate = new Promise<void>((resolve) => {
        releaseResize = resolve;
    });
    const resizing = process.resize(100, 40);
    await waitFor(() => worker.resizes.length === 1);
    worker.connected?.();
    await Promise.resolve();
    assert.equal(
        worker.attaches.length,
        1,
        "recovery must wait behind the in-flight versioned resize",
    );
    releaseResize();
    await resizing;
    assert.equal(worker.resizes[0]?.version, 1);
    assert.equal(worker.version, 2);

    worker.notification?.({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("live").toString("base64"),
            generation: 9,
            seq: 2,
            terminalId: "remote-terminal",
        },
    });
    worker.notification?.({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("duplicate").toString("base64"),
            generation: 9,
            seq: 2,
            terminalId: "remote-terminal",
        },
    });
    assert.deepEqual(output, ["replay", "live"]);

    await waitFor(() => worker.attaches.length === 2);
    assert.equal(worker.attaches[1]?.generation, 9);
    assert.equal(worker.attaches[1]?.terminalId, "remote-terminal");
    assert.equal([1, 2].includes(worker.attaches[1]?.fromSeq ?? -1), true);
    assert.deepEqual(output, ["replay", "live"]);

    await process.kill();
    assert.equal(worker.kills[0]?.version, 2);
});

test("a lost resume reply keeps the session running until the next reconnect", async (t) => {
    const worker = new FakeWorkerTerminal();
    const backend = new WorkerTerminalBackend({ worker });
    const service = new TerminalSessionService();
    t.after(() => service.close());
    const errors: Error[] = [];
    const opened = await service.open({
        backend: {
            open: async (input) => {
                const opened = await backend.open(input);
                assert.ok("process" in opened);
                opened.process.onError!((error) => errors.push(error));
                return opened;
            },
        },
        cols: 80,
        instance: "alpha",
        rows: 24,
        workspace: "/workspace",
    });
    const output: Array<{ data: string; seq: number }> = [];
    const exits: TerminalProcessExit[] = [];
    const attachment = service.attach({
        fromSeq: 0,
        generation: opened.generation,
        onExit: (exit) => exits.push(exit),
        onOutput: (frame) => output.push(frame),
        terminalId: opened.terminalId,
    });
    assert.deepEqual(attachment.replay, [{ data: "replay", seq: 1 }]);
    const resumeInput = { ...openAttachInput, fromSeq: 1 };
    const connected = worker.connected;
    assert.ok(connected);

    worker.latestSeq = 2;
    worker.attachErrors.push(createRemoteError({
        code: TRANSPORT_RPC_RESULT_UNCERTAIN_CODE,
        message: "connection closed before the attach reply",
        retryable: false,
    }));
    connected();
    await setImmediate();

    assert.deepEqual(worker.attaches, [openAttachInput, resumeInput]);
    assert.equal(worker.connected, connected);
    assert.equal(service.get(opened.terminalId).state, "running");
    assert.deepEqual(errors, []);
    assert.deepEqual(exits, []);
    assert.deepEqual(output, []);

    connected();
    await setImmediate();

    assert.deepEqual(worker.attaches, [openAttachInput, resumeInput, resumeInput]);
    assert.deepEqual(output, [{ data: "replay", seq: 2 }]);
    assert.deepEqual(errors, []);
    assert.equal(service.get(opened.terminalId).state, "running");

    assert.ok(worker.notification);
    worker.notification({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("live").toString("base64"),
            generation: opened.generation,
            seq: 3,
            terminalId: opened.terminalId,
        },
    });
    worker.notification({
        method: "terminal.exit",
        params: {
            exitCode: 7,
            generation: opened.generation,
            latestSeq: 3,
            signal: 0,
            terminalId: opened.terminalId,
            version: 2,
        },
    });
    assert.deepEqual(output, [{ data: "replay", seq: 2 }, { data: "live", seq: 3 }]);
    assert.deepEqual(exits, [{ exitCode: 7, signal: 0 }]);
    assert.equal(service.get(opened.terminalId).state, "exited");
    assert.equal(worker.connected, undefined);
    assert.equal(worker.disconnected, undefined);
    assert.equal(worker.notification, undefined);
});

test("terminal.error requests recovery but a definitive remote rejection still fails the process", async () => {
    const worker = new FakeWorkerTerminal();
    const backend = new WorkerTerminalBackend({ worker });
    const opened = await backend.open({ cols: 80, rows: 24, workspace: "/workspace" });
    assert.ok("process" in opened);
    const errors: Error[] = [];
    opened.process.onError!((error) => errors.push(error));
    const resumeInput = { ...openAttachInput, fromSeq: 1 };
    const notify = worker.notification;
    assert.ok(notify);
    const notification = {
        method: "terminal.error" as const,
        params: { generation: 9, message: "stream disconnected", terminalId: "remote-terminal" },
    };

    worker.attachErrors.push(Object.assign(new Error("stream disconnected"), {
        code: "terminal.bridgeFailed",
        retryable: false,
    }));
    notify(notification);
    await setImmediate();
    assert.deepEqual(worker.attaches, [openAttachInput, resumeInput]);
    assert.deepEqual(errors, []);
    assert.equal(worker.notification, notify);

    const missing = Object.assign(new Error("unknown process remote-terminal"), {
        code: "process.notFound",
        retryable: false,
    });
    worker.attachErrors.push(missing);
    notify(notification);
    await setImmediate();
    assert.deepEqual(worker.attaches, [openAttachInput, resumeInput, resumeInput]);
    assert.deepEqual(errors, [missing]);
    assert.equal(worker.connected, undefined);
    assert.equal(worker.disconnected, undefined);
    assert.equal(worker.notification, undefined);
});

test("a failed recovery attach releases its listeners and can be recovered again", async (t) => {
    const worker = new FakeWorkerTerminal();
    const backend = new WorkerTerminalBackend({ worker });
    const service = new TerminalSessionService();
    t.after(() => service.close());
    const temporary = new Error("transport closed before attaching");
    worker.attachErrors.push(temporary);

    await assert.rejects(service.recover("alpha", backend), (error) => error === temporary);
    assert.deepEqual(service.list("alpha"), []);
    assert.deepEqual(worker.kills, []);
    assert.equal(worker.connected, undefined);
    assert.equal(worker.disconnected, undefined);
    assert.equal(worker.notification, undefined);

    const [recovered] = await service.recover("alpha", backend);
    assert.ok(recovered);
    assert.equal(recovered.state, "running");
    assert.deepEqual(worker.attaches, [openAttachInput, openAttachInput]);
    const attachment = service.attach({
        fromSeq: 0,
        generation: recovered.generation,
        onOutput() {},
        terminalId: recovered.terminalId,
    });
    assert.deepEqual(attachment.replay, [{ data: "replay", seq: 1 }]);
});

test("worker terminal backend preserves an exit received before listeners are registered", async () => {
    const worker = new FakeWorkerTerminal();
    worker.latestSeq = 0;
    worker.attachExit = { exitCode: 7, signal: 0 };
    const backend = new WorkerTerminalBackend({ worker });
    const opened = await backend.open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    const process = "process" in opened ? opened.process : opened;
    const exits: Array<{ exitCode: number; signal: number }> = [];

    process.onExit((exit) => exits.push(exit));
    await Promise.resolve();

    assert.deepEqual(exits, [{ exitCode: 7, signal: 0 }]);
});

test("worker terminal backend anchors recovered snapshot seq to preserve continuity across Control restarts", async () => {
    const worker = new FakeWorkerTerminal();
    worker.latestSeq = 9;
    const controllable: WorkerTerminalPort = {
        open: (input) => worker.open(input),
        attach: async (input) => {
            worker.attaches.push(input);
            return {
                replay: [],
                session: worker.descriptor(),
                snapshot: { data: "\x1bcscreen-at-9", seq: 9 },
            };
        },
        control: async () => ({}),
        write: (input) => worker.write(input),
        resize: (input) => worker.resize(input),
        kill: (input) => worker.kill(input),
        list: () => worker.list(),
        onNotification: (listener) => worker.onNotification(listener),
        onConnected: (listener) => worker.onConnected(listener),
        onDisconnected: (listener) => worker.onDisconnected(listener),
    };
    const backend = new WorkerTerminalBackend({ worker: controllable });
    const [recovered] = await backend.recover();
    assert.ok(recovered);

    const frames: Array<{ data: string; seq?: number }> = [];
    recovered.process.onData((data, seq) => frames.push({ data, seq }));
    assert.deepEqual(frames, [{ data: "\x1bcscreen-at-9", seq: 10 }]);

    worker.notification?.({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("after-restart").toString("base64"),
            generation: 9,
            seq: 10,
            terminalId: "remote-terminal",
        },
    });
    assert.deepEqual(frames, [
        { data: "\x1bcscreen-at-9", seq: 10 },
        { data: "after-restart", seq: 11 },
    ]);
});

test("worker terminal backend resyncs mid-session stream.gap via restore snapshot without failing session", async () => {
    const worker = new FakeWorkerTerminal();
    worker.latestSeq = 1;
    let attachCalls = 0;
    const controllable: WorkerTerminalPort = {
        open: (input) => worker.open(input),
        attach: async (input) => {
            attachCalls += 1;
            worker.attaches.push(input);
            if (attachCalls === 1) {
                return {
                    replay: [
                        {
                            dataBase64: Buffer.from("initial").toString("base64"),
                            seq: 1,
                        },
                    ],
                    session: worker.descriptor(),
                };
            }
            if (!input.restore) {
                throw Object.assign(new Error("gap"), { code: "stream.gap" });
            }
            return {
                replay: [],
                session: { ...worker.descriptor(), latestSeq: 50 },
                snapshot: { data: "\x1bcresynced-at-50", seq: 50 },
            };
        },
        write: (input) => worker.write(input),
        resize: (input) => worker.resize(input),
        kill: (input) => worker.kill(input),
        list: () => worker.list(),
        onNotification: (listener) => worker.onNotification(listener),
        onConnected: (listener) => worker.onConnected(listener),
        onDisconnected: (listener) => worker.onDisconnected(listener),
    };
    const backend = new WorkerTerminalBackend({ worker: controllable });
    const opened = await backend.open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    const process = "process" in opened ? opened.process : opened;
    const frames: Array<{ data: string; seq?: number }> = [];
    const errors: Error[] = [];
    process.onData((data, seq) => frames.push({ data, seq }));
    process.onError?.((error) => errors.push(error));
    assert.deepEqual(frames, [{ data: "initial", seq: 1 }]);

    // Simulate a lossy drop where frames 2..50 were evicted and seq 51 arrives.
    worker.notification?.({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("dropped-trigger").toString("base64"),
            generation: 9,
            seq: 51,
            terminalId: "remote-terminal",
        },
    });
    await waitFor(() => frames.length === 2);
    assert.deepEqual(errors, []);
    // Contiguous localSeq (2) prevents TerminalSessionService from failing the session.
    assert.deepEqual(frames[1], { data: "\x1bcresynced-at-50", seq: 2 });

    worker.notification?.({
        method: "terminal.output",
        params: {
            dataBase64: Buffer.from("after-resync").toString("base64"),
            generation: 9,
            seq: 51,
            terminalId: "remote-terminal",
        },
    });
    assert.deepEqual(frames[2], { data: "after-resync", seq: 3 });
});

test("a final exit recovers missing output after one transient attachment failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const worker = new FakeWorkerTerminal();
    worker.latestSeq = 1;
    let attaches = 0;
    const port: WorkerTerminalPort = {
        open: (input) => worker.open(input),
        attach: async (input) => {
            attaches += 1;
            worker.attaches.push(input);
            if (attaches === 1)
                return {
                    replay: [{ dataBase64: Buffer.from("initial").toString("base64"), seq: 1 }],
                    session: worker.descriptor(),
                };
            if (attaches === 2) throw new Error("attach temporarily unavailable");
            return {
                replay: [{ dataBase64: Buffer.from("final").toString("base64"), seq: 2 }],
                session: { ...worker.descriptor(), latestSeq: 2, state: "exited", version: 2 },
                exit: { exitCode: 0, signal: 0 },
            };
        },
        write: (input) => worker.write(input),
        resize: (input) => worker.resize(input),
        kill: (input) => worker.kill(input),
        list: () => worker.list(),
        onNotification: (listener) => worker.onNotification(listener),
        onConnected: (listener) => worker.onConnected(listener),
        onDisconnected: (listener) => worker.onDisconnected(listener),
    };
    const opened = await new WorkerTerminalBackend({ worker: port }).open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    assert.ok("process" in opened);
    const process = opened.process;
    const events: Array<string | TerminalProcessExit> = [];
    process.onData((data) => events.push(data));
    process.onExit((exit) => events.push(exit));
    worker.notification?.({
        method: "terminal.exit",
        params: {
            exitCode: 0,
            generation: 9,
            latestSeq: 2,
            signal: 0,
            terminalId: "remote-terminal",
            version: 2,
        },
    });
    await setImmediate();
    assert.equal(attaches, 2);
    assert.deepEqual(events, ["initial"]);
    t.mock.timers.tick(100);
    await setImmediate();
    assert.equal(attaches, 3);
    assert.deepEqual(events, ["initial", "final", { exitCode: 0, signal: 0 }]);
});

test("worker terminal backend syncs post-release session metadata and version so subsequent kill uses bumped version", async () => {
    const worker = new FakeWorkerTerminal();
    worker.latestSeq = 0;
    const controllable: WorkerTerminalPort = {
        open: (input) => worker.open(input),
        attach: (input) => worker.attach(input),
        control: async (input) => {
            if (input.controller === undefined) {
                worker.version = 2;
                return {
                    controller: "ctrl-1",
                    session: {
                        ...worker.descriptor(),
                        cols: 60,
                        humanControl: true,
                        rows: 20,
                        version: 2,
                    },
                    snapshot: { data: "screen", seq: 0 },
                };
            }
            worker.version = 3;
            return {
                released: true,
                session: {
                    ...worker.descriptor(),
                    cols: 120,
                    humanControl: false,
                    rows: 36,
                    version: 3,
                },
            };
        },
        write: (input) => worker.write(input),
        resize: (input) => worker.resize(input),
        kill: (input) => worker.kill(input),
        list: () => worker.list(),
        onNotification: (listener) => worker.onNotification(listener),
        onConnected: (listener) => worker.onConnected(listener),
        onDisconnected: (listener) => worker.onDisconnected(listener),
    };
    const backend = new WorkerTerminalBackend({ worker: controllable });
    const opened = await backend.open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    const process = "process" in opened ? opened.process : opened;
    const metadataUpdates: Array<{
        cols?: number;
        humanControl?: boolean;
        rows?: number;
        version?: number;
    }> = [];
    process.onMetadataChange?.((update) => metadataUpdates.push(update));

    await process.acquireControl?.();
    await process.releaseControl?.();

    const lastUpdate = metadataUpdates.at(-1);
    assert.equal(lastUpdate?.cols, 120);
    assert.equal(lastUpdate?.rows, 36);
    assert.equal(lastUpdate?.version, 3);
    assert.equal(lastUpdate?.humanControl, false);

    await process.kill();
    assert.equal(worker.kills[0]?.version, 3);
});

test("worker terminal backend forwards shell on open, propagates pty=false, and anchors rotated pipe replay", async () => {
    const openInputs: WorkerTerminalOpenInput[] = [];
    const metadataListeners = new Set<
        (notification: WorkerTerminalNotification) => void
    >();
    const pipeDescriptor = (version = 1): WorkerTerminalDescriptor => ({
        cols: 80,
        createdAtMs: 1,
        generation: 4,
        latestSeq: 12,
        pty: false,
        rows: 24,
        state: "running",
        terminalId: "pipe-task-1",
        version,
        workspace: "/workspace",
    });
    let attachCalls = 0;
    const worker: WorkerTerminalPort = {
        open: async (input) => {
            openInputs.push(input);
            return pipeDescriptor();
        },
        attach: async () => {
            attachCalls += 1;
            if (attachCalls === 1) {
                return {
                    replay: [
                        {
                            dataBase64: Buffer.from("line-10\n").toString("base64"),
                            seq: 10,
                        },
                        {
                            dataBase64: Buffer.from("line-11\n").toString("base64"),
                            seq: 11,
                        },
                    ],
                    session: pipeDescriptor(),
                };
            }
            return {
                replay: [
                    {
                        dataBase64: Buffer.from("line-20\n").toString("base64"),
                        seq: 20,
                    },
                ],
                session: { ...pipeDescriptor(2), latestSeq: 20 },
            };
        },
        write: async (input) => ({ ...input, accepted: true }),
        resize: async (input) => ({ ...input, accepted: true }),
        kill: async () => ({ ...pipeDescriptor(3), state: "exited" }),
        list: async () => [pipeDescriptor()],
        onNotification: (listener) => {
            metadataListeners.add(listener);
            return () => metadataListeners.delete(listener);
        },
        onConnected: () => () => undefined,
        onDisconnected: () => () => undefined,
    };

    const backend = new WorkerTerminalBackend({ worker });
    const opened = await backend.open({
        cols: 80,
        rows: 24,
        shell: "/bin/zsh",
        workspace: "/workspace",
    });
    assert.equal(openInputs[0]?.shell, "/bin/zsh");
    assert.ok("identity" in opened);
    assert.equal(opened.identity.pty, false);

    const listed = await backend.listMetadata();
    assert.equal(listed[0]?.pty, false);

    const frames: Array<{ data: string; seq?: number }> = [];
    const metadataUpdates: Array<{ pty?: boolean }> = [];
    opened.process.onData((data, seq) => frames.push({ data, seq }));
    opened.process.onMetadataChange?.((update) => metadataUpdates.push(update));
    assert.deepEqual(frames, [
        { data: "line-10\n", seq: 1 },
        { data: "line-11\n", seq: 2 },
    ]);

    // Trigger mid-session resync where frames 12..19 rotated out on pipe task.
    for (const listener of metadataListeners) {
        listener({
            method: "terminal.output",
            params: {
                dataBase64: Buffer.from("line-20\n").toString("base64"),
                generation: 4,
                seq: 20,
                terminalId: "pipe-task-1",
            },
        });
    }
    await waitFor(() => frames.length === 3);
    assert.deepEqual(frames[2], { data: "line-20\n", seq: 3 });
    assert.equal(metadataUpdates.at(-1)?.pty, false);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error("Timed out waiting for condition.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
