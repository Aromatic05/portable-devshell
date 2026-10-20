import assert from "node:assert/strict";
import test from "node:test";

import type { Instance } from "@portable-devshell/core";
import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

import { ExtensionWorkerCapabilityControl } from "../../../../../src/extension/api/cap/worker/index.ts";
import { InstanceRegistry } from "../../../../../src/instance/Registry.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

interface WorkerCall {
    ctxId?: string;
    extensionId?: string;
    input: JsonValue;
    operationId?: string;
    recording?: "host" | "caller";
    source: ToolCallContext["source"];
    toolName: string;
    workspace?: string;
}

function workerInstance(name = "worker-a") {
    const calls: WorkerCall[] = [];
    const opened: string[] = [];
    const released: string[] = [];
    const releaseAttempts: string[] = [];
    const listeners = new Set<() => void>();
    let active = true;
    let invoke: (signal?: AbortSignal) => Promise<void> = async () => undefined;
    let prepare: () => Promise<void> = async () => undefined;
    let release: () => Promise<void> = async () => undefined;
    const instance = {
        config: { name },
        lifecycle: {
            get active() { return active; },
            onRetiring(listener: () => void) {
                if (!active) listener();
                else listeners.add(listener);
                return () => listeners.delete(listener);
            },
        },
        async openToolSession(workspace: string, id: string) {
            opened.push(id);
            await prepare();
            return {
                environment: {
                    homeDirectory: "/home/worker",
                    platform: { arch: "x86_64", os: "linux" },
                },
                tools: [{ name: "file_read", description: "Read", inputSchema: { type: "object" } }],
                workspace: `/canonical${workspace}`,
            };
        },
        async closeToolSession(id: string) {
            releaseAttempts.push(id);
            await release();
            released.push(id);
        },
        toolCallIngress: {
            async call(
                _instance: string,
                toolName: string,
                input: JsonValue,
                context: ToolCallContext,
                signal?: AbortSignal,
                _transform?: unknown,
                _invocation?: unknown,
                onProgress?: (progress: JsonValue) => void,
                recording?: "host" | "caller",
            ): Promise<JsonValue> {
                calls.push({
                    ctxId: context.ctxId,
                    extensionId: context.extensionId,
                    input,
                    operationId: context.operationId,
                    recording,
                    source: context.source,
                    toolName,
                    workspace: context.workspace,
                });
                await invoke(signal);
                signal?.throwIfAborted();
                onProgress?.({ step: "read" });
                return { input };
            },
        },
    } as unknown as Instance;

    return {
        calls,
        instance,
        opened,
        released,
        releaseAttempts,
        setInvoke(fn: (signal?: AbortSignal) => Promise<void>) { invoke = fn; },
        setPrepare(fn: () => Promise<void>) { prepare = fn; },
        setRelease(fn: () => Promise<void>) { release = fn; },
        retire() {
            active = false;
            for (const listener of listeners) listener();
            listeners.clear();
        },
    };
}

test("Extension Worker execute and delegate use the Instance ToolCall pipeline with distinct transcript owners", async () => {
    const worker = workerInstance();
    const instances = new InstanceRegistry([worker.instance]);
    const execute = new ExtensionWorkerCapabilityControl({
        allowed: true, extensionId: "secret", instances, recording: "host",
    });
    const delegate = new ExtensionWorkerCapabilityControl({
        allowed: true, extensionId: "agent", instances, recording: "caller",
    });
    const first = await execute.openSession({ instance: "worker-a", workspace: "/repo" });
    const second = await delegate.openSession({ workspace: "/repo" });
    assert.equal(first.workspace, "/canonical/repo");
    assert.equal(first.environment.platform.os, "linux");
    assert.deepEqual(first.listTools(), [{ name: "file_read", description: "Read", inputSchema: { type: "object" } }]);

    const progress: JsonValue[] = [];
    assert.deepEqual(
        await first.callTool("file_read", { path: "file" }, {
            operationId: "op-1", onProgress: (value) => progress.push(value),
        }),
        { input: { path: "file" } },
    );
    await second.callTool("file_read", { path: "other" });
    assert.deepEqual(progress, [{ step: "read" }]);
    assert.deepEqual(worker.calls.map(({ recording, source, workspace }) => ({ recording, source, workspace })), [
        { recording: "host", source: "extension", workspace: "/canonical/repo" },
        { recording: "caller", source: "extension", workspace: "/canonical/repo" },
    ]);
    assert.equal(worker.calls[0]?.operationId, "op-1");
    await Promise.all([execute.closeAll(), delegate.closeAll()]);
    await Promise.all([first.closed, second.closed]);
    assert.equal(worker.opened.length, 2);
    assert.deepEqual(new Set(worker.released), new Set(worker.opened));
    await assert.rejects(execute.openSession({ workspace: "/repo" }), /closed/u);
});

test("Worker close drains calls and retains failed release for explicit retirement retry", async () => {
    const worker = workerInstance();
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]), recording: "caller",
    });
    const finishCall = deferred();
    const started = deferred();
    worker.setInvoke(async () => { started.resolve(); await finishCall.promise; });
    const failure = new Error("transient release failure");
    worker.setRelease(async () => { throw failure; });
    const session = await capability.openSession({ workspace: "/repo" });
    let closed = false;
    void session.closed.then(() => { closed = true; });
    const call = session.callTool("file_read", {});
    const rejectedCall = assert.rejects(call, /closed/u);
    await started.promise;
    const closing = session.close();
    assert.equal(session.close(), closing);
    const rejectedClose = assert.rejects(closing, failure);
    await assert.rejects(session.callTool("file_read", {}), /closed/u);
    assert.deepEqual(worker.releaseAttempts, []);
    finishCall.resolve();
    await rejectedCall;
    await rejectedClose;
    assert.deepEqual(worker.released, []);
    assert.equal(closed, false);
    const releasing = deferred();
    worker.setRelease(async () => await releasing.promise);
    const retirement = capability.retireInstance("worker-a");
    const disposing = capability.closeAll();
    releasing.resolve();
    await Promise.all([retirement, disposing, session.closed]);
    assert.deepEqual(worker.releaseAttempts, [worker.opened[0], worker.opened[0]]);
    assert.deepEqual(worker.released, worker.opened);
    await session.close();
    await capability.closeAll();
    assert.equal(worker.releaseAttempts.length, 2);
});

test("Worker closeAll retries failed cleanup without releasing successful sessions twice", async () => {
    const alpha = workerInstance("alpha");
    const beta = workerInstance("beta");
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([alpha.instance, beta.instance]), recording: "caller",
    });
    const first = await capability.openSession({ instance: "alpha", workspace: "/a" });
    const second = await capability.openSession({ instance: "beta", workspace: "/b" });
    let closed = false;
    void first.closed.then(() => { closed = true; });
    const failure = new Error("release unavailable");
    alpha.setRelease(async () => { throw failure; });
    await assert.rejects(capability.closeAll(), failure);
    await second.closed;
    assert.equal(closed, false);
    await assert.rejects(capability.openSession({ instance: "beta", workspace: "/b" }), /closed/u);
    await assert.rejects(capability.closeAll(), failure);
    assert.equal(alpha.releaseAttempts.length, 2);
    alpha.setRelease(async () => {});
    await capability.closeAll();
    await first.closed;
    assert.equal(alpha.releaseAttempts.length, 3);
    assert.equal(beta.releaseAttempts.length, 1);
});

test("Worker Instance retirement failure remains owned for generation disposal retry", async (t) => {
    const worker = workerInstance();
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]), recording: "caller",
    });
    const failure = new Error("retirement release failure");
    worker.setRelease(async () => { throw failure; });
    const reported = deferred();
    const warnings = t.mock.method(console, "warn", () => reported.resolve());
    const session = await capability.openSession({ workspace: "/repo" });
    let closed = false;
    void session.closed.then(() => { closed = true; });
    worker.retire();
    await reported.promise;
    assert.equal(warnings.mock.callCount(), 1);
    assert.equal(warnings.mock.calls[0]!.arguments[1], failure);
    assert.equal(closed, false);
    await assert.rejects(session.callTool("file_read", {}), /closed/u);
    worker.setRelease(async () => {});
    await Promise.all([capability.closeAll(), capability.retireInstance("worker-a")]);
    await session.closed;
    assert.equal(worker.releaseAttempts.length, 2);
    assert.deepEqual(worker.released, worker.opened);
    await session.close();
    assert.equal(worker.releaseAttempts.length, 2);
});

test("Worker retains a rejected open when its cleanup fails validation", async () => {
    const worker = workerInstance();
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]), recording: "caller",
    });
    const failure = new Error("pending session release failure");
    worker.setRelease(async () => { throw failure; });
    await assert.rejects(capability.openSession({ workspace: "/repo", ctxId: "unvalidated" }), failure);
    assert.equal(worker.releaseAttempts.length, 1);
    await assert.rejects(capability.closeAll(), failure);
    assert.equal(worker.releaseAttempts.length, 2);
    worker.setRelease(async () => {});
    await capability.closeAll();
    assert.equal(worker.releaseAttempts.length, 3);
    assert.deepEqual(worker.released, worker.opened);
});

test("Worker retains a late open after failed retirement and coalesces concurrent retirement", async () => {
    const worker = workerInstance();
    const started = deferred();
    const opening = deferred();
    worker.setPrepare(async () => { started.resolve(); await opening.promise; });
    const failure = new Error("late session release failure");
    worker.setRelease(async () => { throw failure; });
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]), recording: "caller",
    });
    const pending = capability.openSession({ workspace: "/repo" });
    const rejectedOpen = assert.rejects(pending, failure);
    await started.promise;
    const retiring = capability.retireInstance("worker-a");
    assert.equal(capability.retireInstance("worker-a"), retiring);
    const rejectedRetirement = assert.rejects(retiring, failure);
    opening.resolve();
    await Promise.all([rejectedOpen, rejectedRetirement]);
    assert.deepEqual(worker.released, []);
    worker.setRelease(async () => {});
    await capability.retireInstance("worker-a");
    assert.deepEqual(worker.released, worker.opened);
    const attempts = worker.releaseAttempts.length;
    await capability.closeAll();
    assert.equal(worker.releaseAttempts.length, attempts);
});

test("Extension Worker binds ToolCalls to a validated Context without inventing one for independent calls", async () => {
    const worker = workerInstance();
    const verified: string[] = [];
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true,
        extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]),
        recording: "caller",
        validateContext: async (ctxId, instance, workspace) => {
            verified.push(`${ctxId}:${instance}:${workspace}`);
            if (ctxId !== "ctx-valid") throw new Error("Context is not bound to this Workspace.");
        },
    });
    const bound = await capability.openSession({
        ctxId: "ctx-valid", instance: "worker-a", workspace: "/repo",
    });
    const independent = await capability.openSession({ workspace: "/repo" });
    await bound.callTool("file_read", { path: "associated" });
    await independent.callTool("file_read", { path: "independent" });
    assert.deepEqual(verified, ["ctx-valid:worker-a:/canonical/repo"]);
    assert.deepEqual(worker.calls.map((call) => call.ctxId), ["ctx-valid", undefined]);
    assert.deepEqual(worker.calls.map((call) => call.extensionId), ["agent", "agent"]);
    await assert.rejects(
        capability.openSession({ ctxId: "ctx-other", instance: "worker-a", workspace: "/repo" }),
        /not bound/u,
    );
    assert.equal(worker.released.length, 1, "invalid Context releases the pending Worker session");
    assert.equal(worker.opened.length, 3);
    await capability.closeAll();
    assert.deepEqual(new Set(worker.released), new Set(worker.opened));
});

test("Extension Worker does not accept a Context without host validation", async () => {
    const worker = workerInstance();
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true,
        extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]),
        recording: "caller",
    });
    await assert.rejects(
        capability.openSession({ ctxId: "ctx-unchecked", workspace: "/repo" }),
        /cannot be validated/u,
    );
    assert.deepEqual(worker.released, worker.opened);
    await capability.closeAll();
});

test("Extension Worker sessions abort ongoing calls when their Instance retires", async () => {
    const worker = workerInstance();
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true,
        extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]),
        recording: "caller",
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    worker.setInvoke(async (signal) => {
        started();
        if (signal?.aborted === true) signal.throwIfAborted();
        await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    });
    const session = await capability.openSession({ instance: "worker-a", workspace: "/repo" });
    const pending = session.callTool("file_read", { path: "file" });
    await running;
    worker.retire();
    await assert.rejects(pending, /closed/iu);
    await session.closed;
    assert.equal(worker.released.length, 1);
    await assert.rejects(session.callTool("file_read", {}), /closed/iu);
    await capability.closeAll();
});

test("Extension Worker generation retirement closes sessions without closing unrelated Instances", async () => {
    const alpha = workerInstance("alpha");
    const beta = workerInstance("beta");
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true,
        extensionId: "agent",
        instances: new InstanceRegistry([alpha.instance, beta.instance]),
        recording: "caller",
    });
    const first = await capability.openSession({ instance: "alpha", workspace: "/a" });
    const second = await capability.openSession({ instance: "beta", workspace: "/b" });
    await capability.retireInstance("alpha");
    await first.closed;
    assert.equal(alpha.released.length, 1);
    assert.equal(beta.released.length, 0);
    assert.deepEqual(await second.callTool("file_read", { path: "b" }), { input: { path: "b" } });
    await capability.closeAll();
    await second.closed;
    assert.equal(beta.released.length, 1);
});

test("Extension Worker retirement drains sessions still opening without exposing late sessions", async () => {
    const worker = workerInstance();
    let openingStarted!: () => void;
    const started = new Promise<void>((resolve) => { openingStarted = resolve; });
    let finishOpening!: () => void;
    worker.setPrepare(async () => {
        openingStarted();
        await new Promise<void>((resolve) => { finishOpening = resolve; });
    });
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true,
        extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]),
        recording: "caller",
    });
    const pending = capability.openSession({ workspace: "/repo" });
    await started;
    const retiring = capability.retireInstance("worker-a");
    await assert.rejects(capability.openSession({ instance: "worker-a", workspace: "/repo" }), /unavailable/u);
    finishOpening();
    await assert.rejects(pending, /retired/u);
    await retiring;
    assert.deepEqual(worker.released, worker.opened);
    await capability.closeAll();
});
