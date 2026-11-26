import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
    asInstanceName,
    Endpoint,
    type ControlStreamMessage,
    type JsonValue,
} from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { InstancePaths } from "../../../src/instance/model/Paths.ts";
import { InstanceState } from "../../../src/instance/model/State.ts";
import type {
    TerminalProcess,
    TerminalProcessExit,
    TerminalProcessMetadataUpdate,
    WorkerTerminalNotification,
    WorkerTerminalPort,
} from "../../../src/terminal/Api.ts";
import { createTerminalRouteModule } from "../../../src/terminal/Route.ts";
import { TerminalSessionService } from "../../../src/terminal/Service.ts";

class StreamHarness {
    readonly sent: ControlStreamMessage[] = [];
    closed = false;
    cancelled = false;
    #onData?: (message: ControlStreamMessage) => Promise<void> | void;
    #onClose?: () => void;
    #onCancel?: () => void;

    constructor(private readonly onSend?: () => void) {}

    async send(message: ControlStreamMessage): Promise<void> {
        this.sent.push(message);
        this.onSend?.();
    }

    async close(): Promise<void> {
        this.closed = true;
        this.#onClose?.();
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
        this.#onCancel?.();
    }

    onClose(listener: () => void): () => void {
        this.#onClose = listener;
        return () => {
            if (this.#onClose === listener) this.#onClose = undefined;
        };
    }

    onCancel(listener: () => void): () => void {
        this.#onCancel = listener;
        return () => {
            if (this.#onCancel === listener) this.#onCancel = undefined;
        };
    }

    onData(
        listener: (message: ControlStreamMessage) => Promise<void> | void,
    ): () => void {
        this.#onData = listener;
        return () => {
            if (this.#onData === listener) this.#onData = undefined;
        };
    }

    async deliver(message: ControlStreamMessage): Promise<void> {
        await this.#onData?.(message);
    }
}

function attachContext(requestId: string) {
    return {
        afterReply() {},
        connectionId: `conn-${requestId}`,
        host: "alpha",
        peer: "tui" as const,
        requestId,
        signal: new AbortController().signal,
        sourceHost: "client",
    };
}

test("terminal route sends non-fatal controlChanged error when a second attachment requests takeover and keeps stream open", async () => {
    const dataListeners = new Set<(data: string, sourceSeq?: number) => void>();
    const metadataListeners = new Set<
        (update: { humanControl?: boolean; version?: number }) => void
    >();
    let currentController = false;
    const process: TerminalProcess = {
        async acquireControl() {
            currentController = true;
            for (const listener of metadataListeners) {
                listener({ humanControl: true, version: 2 });
            }
            return { data: "snap", seq: 0 };
        },
        async releaseControl() {
            currentController = false;
            for (const listener of metadataListeners) {
                listener({ humanControl: false, version: 3 });
            }
        },
        kill() {},
        onData(listener) {
            dataListeners.add(listener);
            return () => dataListeners.delete(listener);
        },
        onExit() {
            return () => undefined;
        },
        onMetadataChange(listener) {
            metadataListeners.add(listener);
            return () => metadataListeners.delete(listener);
        },
        resize() {},
        write() {},
    };
    const emitOutput = (data: string) => {
        for (const listener of dataListeners) listener(data);
    };

    const sessions = new TerminalSessionService({
        idFactory: () => "term-route-1",
    });
    const backend = { open: async () => process };
    const opened = await sessions.open({
        backend,
        cols: 80,
        instance: "alpha",
        rows: 24,
        workspace: "/workspace",
    });
    const route = createTerminalRouteModule({
        backend,
        instance: "alpha",
        sessions,
    });
    const attach = route.streams?.find((entry) => entry.name === "attach");
    assert.ok(attach);

    const primary = new StreamHarness();
    const observer = new StreamHarness();
    const primaryDone = attach.handle(
        primary as never,
        {
            id: "attach-primary",
            name: "attach",
            payload: {
                fromSeq: 0,
                generation: opened.generation,
                takeover: true,
                terminalId: opened.terminalId,
            },
        },
        attachContext("attach-primary"),
    );
    const observerDone = attach.handle(
        observer as never,
        {
            id: "attach-observer",
            name: "attach",
            payload: {
                fromSeq: 0,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        },
        attachContext("attach-observer"),
    );

    await waitFor(() =>
        primary.sent.some((msg) => msg.name === "seed") &&
        observer.sent.some((msg) => msg.name === "seed"),
    );
    assert.equal(currentController, true);

    await observer.deliver({
        name: "control",
        payload: {
            clientSeq: 7,
            generation: opened.generation,
            takeover: true,
            terminalId: opened.terminalId,
            version: opened.version,
        },
    });

    assert.equal(observer.closed, false);
    assert.equal(observer.cancelled, false);
    const controlReply = observer.sent.find(
        (msg) => msg.name === "controlChanged",
    );
    assert.ok(controlReply);
    const payload = controlReply.payload as Record<string, JsonValue>;
    assert.equal(payload.clientSeq, 7);
    assert.equal(payload.humanControl, false);
    assert.match(String(payload.error), /Another attachment controls/u);

    emitOutput("still-alive");
    await waitFor(() =>
        observer.sent.some(
            (msg) =>
                msg.name === "output" &&
                (msg.payload as { data?: string }).data === "still-alive",
        ),
    );

    await primary.close();
    await observer.close();
    await Promise.all([primaryDone, observerDone]);
});

test("InstanceState emits terminal.controlReleased for unregistered worker PTYs without duplicating registered sessions", async (t) => {
    const root = await createTestTempDirectory("state-handoff");
    const instanceName = asInstanceName("alpha");
    const paths = new InstancePaths(instanceName, root);
    const audit = createAuditRuntime({
        eventBufferSize: 100,
        filePath: paths.auditDatabaseFile,
        instanceName,
    });
    const endpoint = new Endpoint({ host: "alpha-worker" });
    const events: Array<{ data?: JsonValue; type: string }> = [];
    const listeners = new Set<(notification: WorkerTerminalNotification) => void>();
    const registeredProcess: TerminalProcess = {
        kill() {},
        onData() {
            return () => undefined;
        },
        onExit(_listener: (exit: TerminalProcessExit) => void) {
            return () => undefined;
        },
        resize() {},
        write() {},
    };
    const terminalPort: WorkerTerminalPort = {
        open: async () => ({
            cols: 80,
            createdAtMs: 1,
            generation: 1,
            latestSeq: 0,
            rows: 24,
            state: "running",
            terminalId: "registered-term",
            version: 1,
            workspace: "/repo",
        }),
        attach: async () => ({
            replay: [],
            session: {
                cols: 80,
                createdAtMs: 1,
                generation: 1,
                latestSeq: 0,
                rows: 24,
                state: "running",
                terminalId: "registered-term",
                version: 1,
                workspace: "/repo",
            },
        }),
        write: async (input) => ({ ...input, accepted: true }),
        resize: async (input) => ({ ...input, accepted: true }),
        kill: async () => ({
            cols: 80,
            createdAtMs: 1,
            generation: 1,
            latestSeq: 0,
            rows: 24,
            state: "exited",
            terminalId: "registered-term",
            version: 2,
            workspace: "/repo",
        }),
        list: async () => [],
        onNotification: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        onConnected: () => () => undefined,
        onDisconnected: () => () => undefined,
    };

    let seq = 0;
    const state = new InstanceState({
        acquireLease: () => ({ release() {} }),
        appendEvent: async (type, data) => {
            events.push({ data, type });
            await audit.api.events.append({
                at: new Date().toISOString(),
                data,
                instanceName,
                seq: ++seq,
                type,
            });
        },
        assertReady() {},
        audit,
        config: { approvalPolicy: { mode: "disabled" } } as never,
        endpoint,
        instanceName,
        paths,
        prepareWorkspace: async () => {
            throw new Error("unused");
        },
        readTools: async () => [],
        releaseWorkspace: async () => {},
        terminal: terminalPort,
    });

    t.after(async () => {
        await state.close();
        endpoint.close();
        await rm(root, { force: true, recursive: true });
    });

    await state.terminal.sessions.api.open({
        backend: { open: async () => registeredProcess },
        cols: 80,
        instance: instanceName,
        rows: 24,
        workspace: "/repo",
    });
    const registeredId = state.terminal.sessions.api.list(instanceName)[0]!.terminalId;

    const emitNotification = (notification: WorkerTerminalNotification) => {
        for (const listener of [...listeners]) listener(notification);
    };

    // Registered session notifications must not emit a duplicate event from State.ts.
    emitNotification({
        method: "terminal.control",
        params: {
            cols: 80,
            generation: 1,
            humanControl: false,
            rows: 24,
            terminalId: registeredId,
        },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        events.filter((event) => event.type === "terminal.controlReleased").length,
        0,
    );

    // Unregistered worker PTY release notification emits terminal.controlReleased.
    emitNotification({
        method: "terminal.control",
        params: {
            cols: 120,
            cwd: "./app",
            generation: 4,
            humanControl: false,
            name: "worker-shell",
            rows: 36,
            terminalId: "unregistered-pty",
            workspace: "/repo",
        },
    });
    await waitFor(
        () =>
            events.filter((event) => event.type === "terminal.controlReleased")
                .length === 1,
    );
    const handoff = events.find(
        (event) => event.type === "terminal.controlReleased",
    );
    assert.deepEqual(
        {
            ...(handoff?.data as Record<string, unknown>),
            releasedAt: "checked",
        },
        {
            cols: 120,
            cwd: "./app",
            generation: 4,
            name: "worker-shell",
            releasedAt: "checked",
            rows: 36,
            terminalId: "unregistered-pty",
            workspace: "/repo",
        },
    );

    await state.retire();
    assert.equal(listeners.size, 0);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error("Timed out waiting for condition.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test("terminal route accepts in-flight output ACKs covered by a takeover snapshot", async (t) => {
    const dataListeners = new Set<(data: string, sourceSeq?: number) => void>();
    const metadataListeners = new Set<
        (update: TerminalProcessMetadataUpdate) => void
    >();
    const process: TerminalProcess = {
        async acquireControl() {
            for (const listener of metadataListeners) {
                listener({ humanControl: true, version: 2 });
            }
            return { data: "snap", seq: 3 };
        },
        async releaseControl() {},
        kill() {},
        onData(listener) {
            dataListeners.add(listener);
            return () => dataListeners.delete(listener);
        },
        onExit() {
            return () => undefined;
        },
        onMetadataChange(listener) {
            metadataListeners.add(listener);
            return () => metadataListeners.delete(listener);
        },
        resize() {},
        write() {},
    };
    const emitOutput = (data: string) => {
        for (const listener of dataListeners) listener(data);
    };

    const sessions = new TerminalSessionService({
        idFactory: () => "term-route-prune",
    });
    const backend = { open: async () => process };
    const opened = await sessions.open({
        backend,
        cols: 80,
        instance: "alpha",
        rows: 24,
        workspace: "/workspace",
    });
    const route = createTerminalRouteModule({
        backend,
        instance: "alpha",
        maxUnackedBytes: 20,
        sessions,
    });
    const attach = route.streams?.find((entry) => entry.name === "attach");
    assert.ok(attach);

    const events = new EventEmitter();
    const stream = new StreamHarness(() => events.emit("send"));
    const identity = {
        generation: opened.generation,
        terminalId: opened.terminalId,
        version: opened.version,
    };
    const ack = (
        throughSeq: number,
        overrides: Partial<typeof identity> = {},
    ) => ({
        name: "ack",
        payload: { ...identity, ...overrides, throughSeq },
    });

    emitOutput("already seen");
    const seedSent = once(events, "send");
    const done = attach.handle(
        stream as never,
        {
            id: "attach-prune",
            name: "attach",
            payload: {
                fromSeq: 1,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        },
        attachContext("attach-prune"),
    );
    t.after(async () => {
        await stream.close();
        await done;
    });

    await seedSent;
    assert.equal(stream.sent[0]?.name, "seed");
    const sendOutput = async (data: string, seq: number) => {
        const sent = once(events, "send");
        emitOutput(data);
        await sent;
        assert.deepEqual(stream.sent.at(-1), {
            name: "output",
            payload: { data, seq },
            seq,
        });
    };
    await sendOutput("1234567890", 2);
    const delayedAck = ack(2);
    await sendOutput("abcdefghij", 3);

    // The takeover arrives before the ACK for the already-sent frame 2.
    await stream.deliver({
        name: "control",
        payload: { ...identity, clientSeq: 1, takeover: true },
    });
    const reply = stream.sent.at(-1);
    assert.equal(reply?.name, "controlChanged");
    const payload = reply?.payload as Record<string, JsonValue>;
    assert.deepEqual(payload.snapshot, { data: "snap", seq: 3 });
    assert.equal((payload.session as { version: number }).version, 2);

    await stream.deliver(delayedAck);
    await stream.deliver(delayedAck);

    const invalidSequence = {
        code: "control.invalidTarget",
        message: "Terminal acknowledgement sequence is invalid.",
    };
    await assert.rejects(stream.deliver(ack(0)), invalidSequence);
    await assert.rejects(stream.deliver(ack(4)), invalidSequence);
    await assert.rejects(
        stream.deliver(ack(2, { terminalId: "other-terminal" })),
        {
            code: "control.invalidTarget",
            message: "Terminal stream identity does not match the attachment.",
        },
    );
    await assert.rejects(
        stream.deliver(ack(2, { generation: opened.generation + 1 })),
        { code: "instance.conflict", message: "Terminal generation is stale." },
    );

    // The snapshot cleared the full window; a new ACK can clear it again.
    await sendOutput("12345678901234567890", 4);
    await stream.deliver(ack(4, { version: 2 }));
    await assert.rejects(stream.deliver(delayedAck), invalidSequence);
    await sendOutput("12345678901234567890", 5);
    assert.equal(stream.cancelled, false);
    assert.equal(stream.closed, false);
});

test("terminal route ignores controlChanged send when stream has already closed", async () => {
    const process: TerminalProcess = {
        async acquireControl() {
            return { data: "snap", seq: 0 };
        },
        async releaseControl() {},
        kill() {},
        onData() {
            return () => undefined;
        },
        onExit() {
            return () => undefined;
        },
        resize() {},
        write() {},
    };
    const sessions = new TerminalSessionService({
        idFactory: () => "term-route-closed",
    });
    const backend = { open: async () => process };
    const opened = await sessions.open({
        backend,
        cols: 80,
        instance: "alpha",
        rows: 24,
        workspace: "/workspace",
    });
    const route = createTerminalRouteModule({
        backend,
        instance: "alpha",
        sessions,
    });
    const attach = route.streams?.find((entry) => entry.name === "attach");
    assert.ok(attach);

    class StrictClosedStream extends StreamHarness {
        override async send(message: ControlStreamMessage): Promise<void> {
            if (this.closed) {
                throw new Error("Cannot send on closed stream");
            }
            await super.send(message);
        }
    }

    const stream = new StrictClosedStream();
    const done = attach.handle(
        stream as never,
        {
            id: "attach-closed",
            name: "attach",
            payload: {
                fromSeq: 0,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        },
        attachContext("attach-closed"),
    );

    await waitFor(() => stream.sent.some((msg) => msg.name === "seed"));
    await stream.close();
    await done;

    // Delivering a control event after stream close must not throw.
    await assert.doesNotReject(() =>
        stream.deliver({
            name: "control",
            payload: {
                clientSeq: 2,
                generation: opened.generation,
                takeover: true,
                terminalId: opened.terminalId,
                version: opened.version,
            },
        }),
    );
    assert.equal(
        stream.sent.some((msg) => msg.name === "controlChanged"),
        false,
    );
});

test("terminal route forwards shell on open, rejects takeover on pipe tasks, and skips restoreSnapshot on pipe observe", async () => {
    let restoreSnapshotCalls = 0;
    const dataListeners = new Set<(data: string, sourceSeq?: number) => void>();
    const openInputs: Array<{ shell?: string }> = [];
    const process: TerminalProcess = {
        kill() {},
        onData(listener) {
            dataListeners.add(listener);
            return () => dataListeners.delete(listener);
        },
        onExit() {
            return () => undefined;
        },
        resize() {},
        async restoreSnapshot() {
            restoreSnapshotCalls += 1;
            return { data: "unexpected", seq: 1 };
        },
        write() {},
    };
    const sessions = new TerminalSessionService({
        maxReplayBytes: 6,
    });
    const backend = {
        open: async (input: { shell?: string }) => {
            openInputs.push({
                ...(input.shell === undefined ? {} : { shell: input.shell }),
            });
            return {
                identity: {
                    cols: 80,
                    generation: 1,
                    pty: false,
                    rows: 24,
                    terminalId: "pipe-route-1",
                    version: 1,
                    workspace: "/workspace",
                },
                process,
            };
        },
    };
    const route = createTerminalRouteModule({
        backend,
        instance: "alpha",
        sessions,
    });
    const openHandler = route.operations.find((entry) => entry.name === "open");
    const attach = route.streams?.find((entry) => entry.name === "attach");
    assert.ok(openHandler);
    assert.ok(attach);

    const opened = (await openHandler.handle(
        {
            id: "open-pipe",
            name: "open",
            payload: {
                cols: 80,
                rows: 24,
                shell: "/bin/sh",
                workspace: "/workspace",
            },
        },
        attachContext("open-pipe"),
    )) as { generation: number; pty?: boolean; terminalId: string };
    assert.equal(openInputs[0]?.shell, "/bin/sh");
    assert.equal(opened.pty, false);

    // Emit enough frames so replay rotates past seq=1.
    for (const listener of dataListeners) {
        listener("1111");
        listener("2222");
    }

    const takeoverStream = new StreamHarness();
    await assert.rejects(
        async () =>
            await attach.handle(
                takeoverStream as never,
                {
                    id: "attach-pipe-takeover",
                    name: "attach",
                    payload: {
                        fromSeq: 0,
                        generation: opened.generation,
                        takeover: true,
                        terminalId: opened.terminalId,
                    },
                },
                attachContext("attach-pipe-takeover"),
            ),
        (error: unknown) =>
            (error as { code?: string; message?: string }).code ===
                "control.invalidTarget" &&
            (error as { message?: string }).message ===
                "Pipe tasks are read-only and do not support takeover.",
    );

    const observeStream = new StreamHarness();
    const observeDone = attach.handle(
        observeStream as never,
        {
            id: "attach-pipe-observe",
            name: "attach",
            payload: {
                fromSeq: 0,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        },
        attachContext("attach-pipe-observe"),
    );

    await waitFor(() =>
        observeStream.sent.some((msg) => msg.name === "seed") &&
        observeStream.sent.some((msg) => msg.name === "output"),
    );
    assert.equal(restoreSnapshotCalls, 0);
    const seed = observeStream.sent.find((msg) => msg.name === "seed");
    assert.equal((seed?.payload as { snapshot?: unknown }).snapshot, undefined);

    await observeStream.close();
    await observeDone;
});
