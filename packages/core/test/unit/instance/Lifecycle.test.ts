import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, runtimeErrorCodes, type ControlStreamMessage } from "@portable-devshell/shared";

import { Instance } from "../../../src/instance/model/Instance.ts";
import { ReverseExecution } from "../../../src/instance/runtime/execution/provider/Reverse.ts";
import {
    WorkerCommandClient,
    type WorkerRuntime,
} from "../../../src/instance/runtime/execution/Command.ts";
import { WorkerInstanceLifecycle } from "../../../src/instance/runtime/execution/Lifecycle.ts";
import { InstanceStateMachine } from "../../../src/instance/runtime/supervision/State.ts";
import { createTerminalRouteModule } from "../../../src/terminal/Route.ts";
import { TerminalSessionService } from "../../../src/terminal/Service.ts";
import type { TerminalProcess } from "../../../src/terminal/Api.ts";

function createInstance(
    name: string,
    state: {
        prepareRetirement?: () => Promise<void>;
        retire?: () => Promise<void>;
    } = {},
): Instance {
    return new Instance({
        config: { name } as never,
        eventLog: { async flush() {} } as never,
        state: {
            async close() {},
            async prepareRetirement() {
                await state.prepareRetirement?.();
            },
            async retire() {
                await state.retire?.();
            },
        } as never,
        subscriptions: { close() {} } as never,
        worker: {} as never,
    });
}

test("self-managed worker execution rejects controller start and stop", () => {
    const execution = new ReverseExecution({
        applyStateUpdate: async () => ({}) as never,
        connection: {} as never,
        name: "reverse-mac",
    });

    for (const operation of [() => execution.start(), () => execution.stop()]) {
        assert.throws(operation, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                runtimeErrorCodes.reverseSelfManagedLifecycle,
            );
            assert.match(
                (error as Error).message,
                /self-managed.*remote machine/iu,
            );
            return true;
        });
    }
});

test("instance retirement blocks new leases and drains existing work", async () => {
    const events: string[] = [];
    const instance = createInstance("reverse-mac", {
        prepareRetirement: async () => {
            events.push("prepare");
        },
        retire: async () => {
            events.push("retire");
        },
    });
    const lease = instance.lifecycle.acquireLease();
    const retirement = instance.retire();

    assert.equal(instance.lifecycle.active, false);
    assert.equal(instance.lifecycle.phase, "retiring");
    assert.strictEqual(instance.retire(), retirement);
    assert.throws(() => instance.lifecycle.acquireLease(), /retired/u);

    await Promise.resolve();
    assert.deepEqual(events, ["prepare"]);
    lease.release();
    await retirement;

    assert.deepEqual(events, ["prepare", "retire"]);
    assert.equal(instance.lifecycle.retired, true);
    assert.equal(instance.lifecycle.phase, "retired");
});

test("retiring a live terminal attachment drains its lease without killing the PTY", async () => {
    let killed = false;
    let closedStream = false;
    const process: TerminalProcess = {
        kill() { killed = true; },
        onData() { return () => undefined; },
        onExit() { return () => undefined; },
        resize() {},
        write() {},
    };
    const sessions = new TerminalSessionService({ idFactory: () => "terminal-retire" });
    const backend = { open: async () => process };
    const opened = await sessions.open({
        backend,
        cols: 80,
        instance: "alpha",
        rows: 24,
        workspace: "/workspace",
    });
    const instance = createInstance("alpha");
    const route = createTerminalRouteModule({
        backend,
        instance: "alpha",
        onRetiring: (detach) => instance.lifecycle.onRetiring(detach),
        sessions,
    });
    const attach = route.streams?.find((entry) => entry.name === "attach");
    assert.ok(attach);
    const stream = {
        async send(_message: ControlStreamMessage) {},
        async close() { closedStream = true; },
        onClose() { return () => undefined; },
        onCancel() { return () => undefined; },
        onData() { return () => undefined; },
    };
    const lease = instance.lifecycle.acquireLease();
    const holding = Promise.resolve(attach.handle(stream as never, {
        id: "attach-retire",
        name: "attach",
        payload: { fromSeq: 0, generation: opened.generation, terminalId: opened.terminalId },
    }, {
        afterReply() {},
        connectionId: "test-client",
        host: "alpha",
        peer: "tui",
        requestId: "attach-retire",
        signal: new AbortController().signal,
        sourceHost: "test-client",
    })).finally(() => lease.release());

    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.race([
        Promise.all([instance.retire(), holding]),
        new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("terminal retirement failed to drain")), 2000),
        ),
    ]);
    assert.equal(instance.lifecycle.phase, "retired");
    assert.equal(closedStream, true);
    assert.equal(killed, false);
    assert.equal(sessions.get(opened.terminalId).state, "running");
    const reattached = sessions.attach({
        fromSeq: 0,
        generation: opened.generation,
        onOutput() {},
        terminalId: opened.terminalId,
    });
    reattached.detach();
});

test("retiring a backpressured terminal attachment releases its lease without waiting on send", async () => {
    let emitOutput!: (data: string) => void;
    let killed = false;
    const process: TerminalProcess = {
        kill() { killed = true; },
        onData(listener) { emitOutput = (data) => listener(data); return () => undefined; },
        onExit() { return () => undefined; },
        resize() {},
        write() {},
    };
    const sessions = new TerminalSessionService({ idFactory: () => "terminal-backpressure" });
    const backend = { open: async () => process };
    const opened = await sessions.open({
        backend, cols: 80, instance: "alpha", rows: 24, workspace: "/workspace",
    });
    const instance = createInstance("alpha");
    const route = createTerminalRouteModule({
        backend,
        instance: "alpha",
        onRetiring: (detach) => instance.lifecycle.onRetiring(detach),
        sessions,
    });
    const attach = route.streams?.find((entry) => entry.name === "attach");
    assert.ok(attach);
    let announceSend!: () => void;
    const sending = new Promise<void>((resolve) => { announceSend = resolve; });
    const neverCompletes = new Promise<void>(() => undefined);
    const stream = {
        async send(message: ControlStreamMessage) {
            if (message.name === "output") {
                announceSend();
                await neverCompletes;
            }
        },
        async close() {},
        onClose() { return () => undefined; },
        onCancel() { return () => undefined; },
        onData() { return () => undefined; },
    };
    const lease = instance.lifecycle.acquireLease();
    const attached = Promise.resolve(attach.handle(stream as never, {
        id: "backpressure", name: "attach",
        payload: { fromSeq: 0, generation: opened.generation, terminalId: opened.terminalId },
    }, {
        afterReply() {}, connectionId: "test-client", host: "alpha", peer: "tui",
        requestId: "backpressure", signal: new AbortController().signal,
        sourceHost: "test-client",
    })).finally(() => lease.release());
    await new Promise<void>((resolve) => setImmediate(resolve));
    emitOutput("blocked-output");
    await sending;

    await Promise.race([
        Promise.all([instance.retire(), attached]),
        new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("retirement waited on blocked terminal send")), 500),
        ),
    ]);
    assert.equal(instance.lifecycle.phase, "retired");
    assert.equal(killed, false);
    assert.equal(sessions.get(opened.terminalId).state, "running");
});

test("failed instance retirement can retry without reopening admission", async () => {
    const failure = new Error("approval retirement failed once");
    let prepareCalls = 0;
    const instance = createInstance("retry", {
        prepareRetirement: async () => {
            prepareCalls += 1;
            if (prepareCalls === 1) throw failure;
        },
    });

    await assert.rejects(instance.retire(), failure);
    assert.equal(instance.lifecycle.phase, "retiring");
    assert.throws(() => instance.lifecycle.acquireLease(), /retired/u);

    const retry = instance.retire();
    await retry;
    assert.strictEqual(instance.retire(), retry);
    assert.equal(instance.lifecycle.phase, "retired");
    assert.equal(prepareCalls, 2);
});

function createRuntime(
    runWorkerCommand: WorkerRuntime["runWorkerCommand"],
): WorkerRuntime {
    return {
        async connectChannel() {
            throw new Error("lifecycle tests do not open worker channels.");
        },
        async installWorker() {},
        runWorkerCommand,
    };
}

function createLifecycleHarness(runtime: WorkerRuntime): {
    lifecycle: WorkerInstanceLifecycle;
    state: InstanceStateMachine;
} {
    const name = asInstanceName("lifecycle-serialization");
    const state = new InstanceStateMachine(name);
    const lifecycle = new WorkerInstanceLifecycle({
        appendEvent: async () => undefined,
        applyStateUpdate: async (update) => state.apply(update),
        commandClient: new WorkerCommandClient(runtime, name),
        config: { name } as never,
        connection: {
            clearHandshake() {},
            closeTransport() {},
            connectStarted: async () =>
                state.apply({
                    connectionState: "connected",
                    daemonState: "running",
                }),
        } as never,
        refreshStatus: async () => state.snapshot(),
    });
    return { lifecycle, state };
}

async function nextMacrotask(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("lifecycle serializes start then stop so stop cannot be reverted to running", async () => {
    const commands: string[] = [];
    let startCompleted = false;
    let stopOverlappedStart = false;
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
        startEntered = resolve;
    });
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    const runtime = createRuntime(async (command) => {
        commands.push(command);
        if (command === "start") {
            startEntered();
            await gate;
            startCompleted = true;
        }
        if (command === "stop" && !startCompleted) stopOverlappedStart = true;
        return { exitCode: 0, stderr: "", stdout: "" };
    });
    const { lifecycle, state } = createLifecycleHarness(runtime);

    const starting = lifecycle.start();
    await entered;
    const stopping = lifecycle.stop();
    await nextMacrotask();

    assert.deepEqual(commands, ["start"]);

    releaseStart();
    await starting;
    const stopped = await stopping;

    assert.deepEqual(commands, ["start", "stop"]);
    assert.equal(stopOverlappedStart, false);
    assert.equal(stopped.daemonState, "stopped");
    assert.equal(stopped.connectionState, "disconnected");
    assert.equal(stopped.ready, false);
    assert.equal(state.snapshot().daemonState, "stopped");
    assert.equal(state.snapshot().ready, false);
});

test("lifecycle serializes concurrent starts in call order", async () => {
    const commands: string[] = [];
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
        startEntered = resolve;
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    let startCount = 0;
    const runtime = createRuntime(async (command) => {
        commands.push(command);
        if (command === "start") {
            startCount += 1;
            if (startCount === 1) {
                startEntered();
                await gate;
            }
        }
        return { exitCode: 0, stderr: "", stdout: "" };
    });
    const { lifecycle } = createLifecycleHarness(runtime);

    const first = lifecycle.start();
    await entered;
    const second = lifecycle.start();
    await nextMacrotask();

    assert.deepEqual(commands, ["start"]);

    releaseFirst();
    await first;
    await second;

    assert.deepEqual(commands, ["start", "start"]);
});

test("lifecycle serializes a start queued behind an in-flight stop", async () => {
    const commands: string[] = [];
    let stopEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
        stopEntered = resolve;
    });
    let releaseStop!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseStop = resolve;
    });
    let stopCompleted = false;
    let startOverlappedStop = false;
    const runtime = createRuntime(async (command) => {
        commands.push(command);
        if (command === "stop") {
            stopEntered();
            await gate;
            stopCompleted = true;
        }
        if (command === "start" && !stopCompleted) startOverlappedStop = true;
        return { exitCode: 0, stderr: "", stdout: "" };
    });
    const { lifecycle, state } = createLifecycleHarness(runtime);

    const stopping = lifecycle.stop();
    await entered;
    const starting = lifecycle.start();
    await nextMacrotask();

    assert.deepEqual(commands, ["stop"]);

    releaseStop();
    await stopping;
    const started = await starting;

    assert.deepEqual(commands, ["stop", "start"]);
    assert.equal(startOverlappedStop, false);
    assert.equal(started.daemonState, "running");
    assert.equal(started.connectionState, "connected");
    assert.equal(started.ready, true);
    assert.equal(state.snapshot().ready, true);
});

test("lifecycle forwards the interactive session and still serializes it", async () => {
    const commands: string[] = [];
    const sessions: unknown[] = [];
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
        startEntered = resolve;
    });
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    let startCount = 0;
    const runtime = createRuntime(
        async (command, _options, interactiveSession) => {
            commands.push(command);
            sessions.push(interactiveSession);
            startCount += 1;
            if (startCount === 1) {
                startEntered();
                await gate;
            }
            return { exitCode: 0, stderr: "", stdout: "" };
        },
    );
    const { lifecycle } = createLifecycleHarness(runtime);
    const session = {
        readInput: async () => undefined,
        writeOutput: async () => undefined,
    };

    const interactive = lifecycle.startInteractive(session as never);
    await entered;
    const stopping = lifecycle.stop();
    await nextMacrotask();

    assert.deepEqual(commands, ["start"]);

    releaseStart();
    await interactive;
    await stopping;

    assert.deepEqual(commands, ["start", "stop"]);
    assert.strictEqual(sessions[0], session);
});

test("lifecycle accepts the next operation after a failed operation", async () => {
    const commands: string[] = [];
    const runtime = createRuntime(async (command) => {
        commands.push(command);
        if (command === "start") {
            return { exitCode: 1, stderr: "start failed", stdout: "" };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
    });
    const { lifecycle, state } = createLifecycleHarness(runtime);

    await assert.rejects(
        lifecycle.start(),
        (error: unknown) =>
            (error as { code?: string }).code ===
            runtimeErrorCodes.workerStartFailed,
    );
    assert.equal(
        state.snapshot().lastErrorCode,
        runtimeErrorCodes.workerStartFailed,
    );

    const stopped = await lifecycle.stop();

    assert.deepEqual(commands, ["start", "stop"]);
    assert.equal(stopped.daemonState, "stopped");
    assert.equal(stopped.connectionState, "disconnected");
    assert.equal(stopped.ready, false);
});
