import assert from "node:assert/strict";
import test from "node:test";

import { Instance } from "@portable-devshell/core";
import { createToolCallRuntime, createToolCallIngressTransport, createToolCallTargetTransport, createPortClient, openToolSessionTransport, asInstanceName, ProcessSubscriptionManager, type JsonValue, type ToolCallContext, type OwnedToolSession, type ToolCallTarget, type ToolCallRuntime, type Endpoint } from "@portable-devshell/shared";
import { workerSessionTransport } from "../../../../support/WorkerSessionTransport.ts";

import { ExtensionWorkerCapabilityControl } from "../../../../../src/extension/api/cap/worker/index.ts";
import { InstanceRegistry } from "../../../../../src/instance/Registry.ts";
import { round4Target, barrier } from "../../../../../../core/test/unit/tool/Round4Harness.ts";
import { registerApprovalToolCallReview } from "../../../../../../core/src/approval/execution/ToolCallReview.ts";

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

function workerInstance(name = "worker-a", options: { runtime?: ToolCallRuntime; target?: ToolCallTarget } = {}) {
    const calls: WorkerCall[] = [];
    const opened: string[] = [];
    const released: string[] = [];
    const releaseAttempts: string[] = [];
    const owned = new Set<string>();
    const supervisionClosed: string[] = [];
    let invoke: (signal?: AbortSignal) => Promise<void> = async () => undefined;
    let prepare: () => Promise<void> = async () => undefined;
    let release: () => Promise<void> = async () => undefined;
    const tools = [{ name: "file_read", description: "Read", inputSchema: { type: "object" } }];
    const target: ToolCallTarget = options.target ?? {
        async dispatch(request) {
            const context = request.value.context;
            calls.push({
                ctxId: context.ctxId, extensionId: context.extensionId,
                input: request.value.payload, operationId: context.operationId,
                recording: request.recording, source: context.source,
                toolName: request.value.toolName, workspace: context.workspace,
            });
            await invoke(request.signal);
            request.signal?.throwIfAborted();
            request.onProgress?.({ step: "read" });
            return { input: request.value.payload };
        },
    };
    const runtime = options.runtime ?? createToolCallRuntime({ resolveTarget: () => target });
    const instance = new Instance({
        config: { name, enabled: true, provider: "local" },
        eventLog: { async flush() {}, port: {} },
        subscriptions: new ProcessSubscriptionManager(),
        worker: {
            execution: { environment: {} },
            supervision: {
                handshake: { homeDirectory: "/home/worker", platform: { arch: "x86_64", os: "linux" } },
                snapshot: () => ({ lastSeq: 0 }), state: { subscribe() {} },
                ownership: { owned: false },
                async close() { supervisionClosed.push(name); },
            },
        },
        state: {
            tools: {
                async openSession(workspace: string, id: string) {
                    opened.push(id);
                    owned.add(id);
                    await prepare();
                    return { workspace: `/canonical${workspace}` };
                },
                async releaseSession(id: string) {
                    if (!owned.has(id)) return;
                    releaseAttempts.push(id);
                    await release();
                    released.push(id);
                    owned.delete(id);
                },
                listTools: () => tools,
            },
            toolDefinitions: { list: () => tools },
            toolCalls: runtime,
            target: () => target,
            approval: { api: {} }, task: { api: { goal: {}, wait: {} } },
            terminal: { api: {}, sessions: { api: {} } },
            async prepareRetirement() {},
            async retire() { runtime.close(); },
            async close() { runtime.close(); },
        },
    } as never);

    return {
        calls,
        runtime,
        supervisionClosed,
        instance,
        opened,
        released,
        releaseAttempts,
        setInvoke(fn: (signal?: AbortSignal) => Promise<void>) { invoke = fn; },
        setPrepare(fn: () => Promise<void>) { prepare = fn; },
        setRelease(fn: () => Promise<void>) { release = fn; },
        retire() {
            instance.lifecycle.beginRetirement();
        },
    };
}

test("Extension Worker execute and delegate use the Instance ToolCall pipeline with distinct transcript owners", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const instances = new InstanceRegistry([worker.instance]);
    const execute = new ExtensionWorkerCapabilityControl({
        endpoint,
        allowed: true, extensionId: "secret", instances, recording: "host",
    });
    const delegate = new ExtensionWorkerCapabilityControl({
        endpoint,
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

test("Worker close drains calls and retains failed release for explicit retirement retry", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]), recording: "caller",
    });
    const finishCall = deferred();
    const started = deferred();
    const aborted = deferred();
    worker.setInvoke(async (signal) => {
        signal!.addEventListener("abort", aborted.resolve, { once: true });
        started.resolve();
        await finishCall.promise;
    });
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
    const rejectedClose = assert.rejects(closing, { message: failure.message });
    await assert.rejects(session.callTool("file_read", {}), /closed/u);
    assert.deepEqual(worker.releaseAttempts, []);
    await aborted.promise;
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

test("Worker closeAll retries failed cleanup without releasing successful sessions twice", async (t) => {
    const alpha = workerInstance("alpha");
    const beta = workerInstance("beta");
    const { endpoint } = await workerSessionTransport(t, [alpha.instance, beta.instance]);
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([alpha.instance, beta.instance]), recording: "caller",
    });
    const first = await capability.openSession({ instance: "alpha", workspace: "/a" });
    const second = await capability.openSession({ instance: "beta", workspace: "/b" });
    let closed = false;
    void first.closed.then(() => { closed = true; });
    const failure = new Error("release unavailable");
    alpha.setRelease(async () => { throw failure; });
    await assert.rejects(capability.closeAll(), { message: failure.message });
    await second.closed;
    assert.equal(closed, false);
    await assert.rejects(capability.openSession({ instance: "beta", workspace: "/b" }), /closed/u);
    await assert.rejects(capability.closeAll(), { message: failure.message });
    assert.equal(alpha.releaseAttempts.length, 2);
    alpha.setRelease(async () => {});
    await capability.closeAll();
    await first.closed;
    assert.equal(alpha.releaseAttempts.length, 3);
    assert.equal(beta.releaseAttempts.length, 1);
});

test("Worker Instance retirement failure remains owned for generation disposal retry", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
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
    assert.equal((warnings.mock.calls[0]!.arguments[1] as Error).message, failure.message);
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

test("Worker retains a rejected open when its cleanup fails validation", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]), recording: "caller",
    });
    const failure = new Error("pending session release failure");
    worker.setRelease(async () => { throw failure; });
    await assert.rejects(capability.openSession({ workspace: "/repo", ctxId: "unvalidated" }), { message: failure.message });
    assert.equal(worker.releaseAttempts.length, 1);
    await assert.rejects(capability.closeAll(), { message: failure.message });
    assert.equal(worker.releaseAttempts.length, 2);
    worker.setRelease(async () => {});
    await capability.closeAll();
    assert.equal(worker.releaseAttempts.length, 3);
    assert.deepEqual(worker.released, worker.opened);
});

test("Worker retains a late open after failed retirement and coalesces concurrent retirement", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const started = deferred();
    const opening = deferred();
    worker.setPrepare(async () => { started.resolve(); await opening.promise; });
    const failure = new Error("late session release failure");
    worker.setRelease(async () => { throw failure; });
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
        allowed: true, extensionId: "agent",
        instances: new InstanceRegistry([worker.instance]), recording: "caller",
    });
    const pending = capability.openSession({ workspace: "/repo" });
    const rejectedOpen = assert.rejects(pending, { message: failure.message });
    await started.promise;
    const retiring = capability.retireInstance("worker-a");
    assert.equal(capability.retireInstance("worker-a"), retiring);
    const rejectedRetirement = assert.rejects(retiring, { message: failure.message });
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

test("Extension Worker binds ToolCalls to a validated Context without inventing one for independent calls", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const verified: string[] = [];
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
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

test("Extension Worker does not accept a Context without host validation", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
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

test("Extension Worker sessions abort ongoing calls when their Instance retires", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
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

test("Extension Worker generation retirement closes sessions without closing unrelated Instances", async (t) => {
    const alpha = workerInstance("alpha");
    const beta = workerInstance("beta");
    const { endpoint } = await workerSessionTransport(t, [alpha.instance, beta.instance]);
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
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

test("Extension Worker retirement drains sessions still opening without exposing late sessions", async (t) => {
    const worker = workerInstance();
    const { endpoint } = await workerSessionTransport(t, [worker.instance]);
    let openingStarted!: () => void;
    const started = new Promise<void>((resolve) => { openingStarted = resolve; });
    let finishOpening!: () => void;
    worker.setPrepare(async () => {
        openingStarted();
        await new Promise<void>((resolve) => { finishOpening = resolve; });
    });
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint,
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

function openInput(worker: ReturnType<typeof workerInstance>, sessionId: string) {
    return {
        generation: worker.instance.lifecycle.generation, sessionId,
        context: { source: "extension" as const, extensionId: "agent", workspace: "/repo", ctxId: "ctx-valid" },
        recording: "host" as const,
    };
}
const boundContext = { source: "extension" as const, extensionId: "agent", workspace: "/canonical/repo", ctxId: "ctx-valid" };

test("retained owner stream releases only its original generation after withdrawal and same-name replacement", { timeout: 5_000 }, async (t) => {
    const old = workerInstance();
    const fresh = workerInstance();
    const instances = new InstanceRegistry([old.instance]);
    const h = await workerSessionTransport(t, [old.instance]);
    const session = await openToolSessionTransport(h.endpoint, "worker-a", openInput(old, "same-id"));
    await session.activate();
    const started = deferred();
    const aborted = deferred();
    const finish = deferred();
    old.setInvoke(async (signal) => {
        signal!.addEventListener("abort", aborted.resolve, { once: true });
        started.resolve();
        await finish.promise;
    });
    const oldCalls = createToolCallIngressTransport(h.endpoint, session.binding);
    const pending = oldCalls.call("worker-a", "file_read", {}, boundContext);
    const rejected = assert.rejects(pending, /closed/u);
    await started.promise;
    old.setRelease(async () => { throw new Error("old release unavailable"); });
    const detached = instances.detach("worker-a", old.instance)!;
    const failedRetirement = assert.rejects(detached.retirement, /release remains incomplete/u);
    h.replace([]);
    instances.add(fresh.instance);
    h.replace([fresh.instance]);
    const next = await openToolSessionTransport(h.endpoint, "worker-a", openInput(fresh, "same-id"));
    await next.activate();
    assert.notEqual(next.binding.generation, session.binding.generation);
    assert.notEqual(next.binding.token, session.binding.token);
    await aborted.promise;
    finish.resolve();
    await Promise.all([rejected, failedRetirement]);
    await assert.rejects(oldCalls.call("worker-a", "file_read", {}, boundContext), /owner or generation/u);
    await assert.rejects(session.close(), /old release unavailable/u);
    assert.deepEqual(old.released, []);
    assert.deepEqual(fresh.released, []);
    old.setRelease(async () => {});
    await session.close();
    await old.instance.retire();
    assert.deepEqual(old.released, ["same-id"]);
    assert.deepEqual(fresh.released, []);
    assert.deepEqual(await createToolCallIngressTransport(h.endpoint, next.binding).call("worker-a", "file_read", {}, boundContext), { input: {} });
    assert.equal(fresh.calls.length, 1);
    assert.equal(old.calls.length, 1);
    await next.close();
    assert.deepEqual(fresh.released, ["same-id"]);
});

test("pending open keeps old admission until prepared, then rolls back after real Instance retirement", { timeout: 5_000 }, async (t) => {
    const old = workerInstance();
    const fresh = workerInstance();
    const h = await workerSessionTransport(t, [old.instance]);
    const instances = new InstanceRegistry([old.instance]);
    const capability = new ExtensionWorkerCapabilityControl({ endpoint: h.endpoint, allowed: true, extensionId: "agent", instances, recording: "host" });
    const started = deferred();
    const prepared = deferred();
    old.setPrepare(async () => { started.resolve(); await prepared.promise; });
    const opening = capability.openSession({ workspace: "/repo" });
    const rejected = assert.rejects(opening, /retired/u);
    await started.promise;
    const detached = instances.detach("worker-a", old.instance)!;
    h.replace([]);
    instances.add(fresh.instance);
    h.replace([fresh.instance]);
    let retired = false;
    void detached.retirement.then(() => { retired = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retired, false);
    prepared.resolve();
    await Promise.all([rejected, detached.retirement]);
    assert.deepEqual(old.released, old.opened);
    assert.deepEqual(fresh.opened, []);
    await capability.closeAll();
});

test("Context validation pending during withdrawal cannot activate and retains failed rollback for retry", { timeout: 5_000 }, async (t) => {
    const old = workerInstance();
    const h = await workerSessionTransport(t, [old.instance]);
    const validating = deferred();
    const validated = deferred();
    const capability = new ExtensionWorkerCapabilityControl({
        endpoint: h.endpoint, allowed: true, extensionId: "agent", recording: "host",
        instances: new InstanceRegistry([old.instance]),
        validateContext: async () => { validating.resolve(); await validated.promise; throw new Error("Context invalid"); },
    });
    const opening = capability.openSession({ ctxId: "ctx-valid", workspace: "/repo" });
    const rejected = assert.rejects(opening, /rollback debt/u);
    await validating.promise;
    old.setRelease(async () => { throw new Error("rollback debt"); });
    const retirement = old.instance.retire();
    const failed = assert.rejects(retirement, /release remains incomplete/u);
    h.replace([]);
    validated.resolve();
    await Promise.all([rejected, failed]);
    assert.equal(old.calls.length, 0);
    assert.deepEqual(old.released, []);
    old.setRelease(async () => {});
    await capability.closeAll();
    await old.instance.retire();
    assert.deepEqual(old.released, old.opened);
});

test("session activation and close require the owning generation, id and server token", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    const port = createPortClient(h.endpoint, asInstanceName("worker-a"), "tool");
    await assert.rejects(openToolSessionTransport(h.endpoint, "worker-a", { ...openInput(worker, "stale"), generation: "old-generation" }), /generation is retired/u);
    assert.deepEqual(worker.opened, []);
    const stream = await port.open("ownedSession", openInput(worker, "owner-a"));
    const first = await stream.readMessage();
    assert.equal(first.type, "data");
    const opened = (first as { message: unknown }).message as OwnedToolSession;
    const other = await openToolSessionTransport(h.endpoint, "worker-a", openInput(worker, "owner-b"));
    const calls = createToolCallIngressTransport(h.endpoint, opened.binding);
    await assert.rejects(calls.call("worker-a", "file_read", {}, boundContext), /owner or generation/u);
    for (const name of ["activate", "close"]) {
        await stream.send({ name, binding: other.binding } as unknown as JsonValue);
        const reply = await stream.readMessage();
        assert.equal(reply.type, "data");
        assert.match((reply as { message: { error: { message: string } } }).message.error.message, /invalid owner token/u);
    }
    assert.deepEqual(worker.released, []);
    await stream.send({ name: "activate", binding: opened.binding } as unknown as JsonValue);
    const activation = await stream.readMessage();
    assert.equal(activation.type, "data");
    assert.deepEqual((activation as { message: unknown }).message, {});
    assert.deepEqual(await calls.call("worker-a", "file_read", {}, boundContext), { input: {} });
    await stream.send({ name: "close", binding: opened.binding } as unknown as JsonValue);
    assert.equal((await stream.readMessage()).type, "close");
    assert.deepEqual(worker.released, ["owner-a"]);
    await assert.rejects(calls.call("worker-a", "file_read", {}, boundContext), /owner or generation/u);
    await other.close();
    assert.deepEqual(worker.released, ["owner-a", "owner-b"]);
});

test("payload cannot impersonate an internal Host, another session or its validated Context", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    const opened = await openToolSessionTransport(h.endpoint, "worker-a", openInput(worker, "trusted"));
    await opened.activate();
    const calls = createToolCallIngressTransport(h.endpoint, opened.binding);
    await assert.rejects(createToolCallIngressTransport(h.endpoint, { ...opened.binding, token: "forged" }).call("worker-a", "file_read", {}, boundContext), /owner or generation/u);
    for (const context of [
        { ...boundContext, extensionId: "other" }, { ...boundContext, ctxId: "other" },
        { ...boundContext, workspace: "/other" }, { ...boundContext, source: "mcp" as const },
    ]) await assert.rejects(calls.call("worker-a", "file_read", {}, context), /Context or transcript/u);
    await assert.rejects(calls.call("worker-a", "file_read", {}, boundContext, undefined, undefined, undefined, undefined, "caller"), /Context or transcript/u);
    const attacker = h.client({ host: h.endpoint.host, admission: { allowedPeers: ["cli"], subject: { id: "web:low", kind: "web" } } });
    const payload = { ...openInput(worker, "forged-host"), sourceHost: h.endpoint.host, peer: "cli", subject: { kind: "local-owner" }, binding: opened.binding };
    await assert.rejects(openToolSessionTransport(attacker, "worker-a", payload), /internal connection/u);
    await assert.rejects(createToolCallIngressTransport(attacker, opened.binding).call("worker-a", "file_read", payload as unknown as JsonValue, boundContext), /internal connection/u);
    assert.deepEqual(worker.opened, ["trusted"]);
    assert.equal(worker.calls.length, 0);
    attacker.close();
    // Re-establish the trusted Host route after a separate low-privilege Channel used the same name.
    await h.endpoint.reconnect();
    const stranger = h.client({ host: h.endpoint.host });
    await assert.rejects(createToolCallIngressTransport(stranger, opened.binding).call("worker-a", "file_read", {}, boundContext), /owner or generation/u);
    stranger.close();
    await worker.instance.retire();
    assert.deepEqual(worker.released, ["trusted"]);
});

test("already aborted calls and abort while connecting settle without an orphan Stream", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    const capability = new ExtensionWorkerCapabilityControl({ endpoint: h.endpoint, allowed: true, extensionId: "agent", instances: new InstanceRegistry([worker.instance]), recording: "host" });
    const session = await capability.openSession({ workspace: "/repo" });
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await assert.rejects(session.callTool("file_read", {}, { signal: controller.signal }), /already cancelled/u);
    assert.equal(worker.calls.length, 0);
    const entered = deferred();
    const connect = deferred();
    const original = h.endpoint.connect.bind(h.endpoint);
    const mocked = t.mock.method(h.endpoint, "connect", async (...args: Parameters<Endpoint["connect"]>) => {
        entered.resolve();
        await connect.promise;
        return await original(...args);
    });
    const delayed = new AbortController();
    const running = session.callTool("file_read", {}, { signal: delayed.signal });
    const rejected = assert.rejects(running, /connect cancelled/u);
    await entered.promise;
    delayed.abort(new Error("connect cancelled"));
    connect.resolve();
    await rejected;
    mocked.mock.restore();
    assert.equal(worker.calls.length, 0);
    await capability.closeAll();
    assert.deepEqual(worker.released, worker.opened);
});

test("disconnect during open settles caller and Instance retains cleanup after the stream disappears", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    const started = deferred();
    const finish = deferred();
    worker.setPrepare(async () => { started.resolve(); await finish.promise; });
    const opening = openToolSessionTransport(h.endpoint, "worker-a", openInput(worker, "disconnect"));
    const rejected = assert.rejects(opening, /closed/u);
    await started.promise;
    h.endpoint.disconnect();
    await rejected;
    finish.resolve();
    await worker.instance.retire();
    assert.deepEqual(worker.released, ["disconnect"]);
});

for (const [recording, decision] of [["host", "approve"], ["host", "deny"], ["caller", "approve"]] as const) {
    test(`Worker Session Transport preserves ${recording} recording, Review/Rewrite and Approval ${decision}`, { timeout: 5_000 }, async (t) => {
        const alpha = await round4Target({}, "alpha");
        const beta = await round4Target({}, "beta");
        t.after(async () => { await alpha.close(); await beta.close(); });
        const runtime = createToolCallRuntime({ resolveTarget: (name) => name === "alpha" ? alpha.tool.target() : createToolCallTargetTransport(endpoint, name) });
        const a = workerInstance("alpha", { runtime, target: alpha.tool.target() });
        const b = workerInstance("beta", { target: beta.tool.target() });
        const { endpoint } = await workerSessionTransport(t, [a.instance, b.instance]);
        const capability = new ExtensionWorkerCapabilityControl({
            endpoint, allowed: true, extensionId: "agent", instances: new InstanceRegistry([a.instance, b.instance]), recording,
            validateContext: async (id, name, workspace) => {
                assert.equal(id, "ctx-valid"); assert.equal(name, "alpha"); assert.equal(workspace, "/canonical/repo");
            },
        });
        const pendingApproval = barrier<string>();
        registerApprovalToolCallReview(runtime.hooks, {
            async evaluate(input, signal) {
                const evaluation = await alpha.approval.evaluate(input, signal);
                assert.equal(evaluation.decision, "ask");
                pendingApproval.resolve((evaluation as { request: { approvalId: string } }).request.approvalId);
                return evaluation;
            },
        });
        let released = 0;
        const seen: unknown[] = [];
        runtime.hooks.registerContributor((context, owner) => {
            seen.push(context);
            assert.equal(owner.recording, recording);
            return {
                reviews: [{ hook: "100-session", id: "review", review: (input) => {
                    assert.equal(input.value.context.extensionId, "agent");
                    assert.equal(input.value.context.ctxId, "ctx-valid");
                    return { decision: "continue" };
                } }],
                rewrites: [{ hook: "600-session", id: "destination", rewrite: (input) => ({
                    ...input.value, context: { ...input.value.context, instance: asInstanceName("beta"), workspace: "/beta" },
                }) }],
                release() { released++; },
            };
        });
        let executions = 0;
        runtime.hooks.registerExecute("file_read", async (_id, input, value, signal, onProgress) => {
            signal?.throwIfAborted();
            executions++;
            assert.equal(value.context.instance, "beta");
            assert.equal(value.context.extensionId, "agent");
            onProgress?.({ step: "executed" });
            return input;
        });
        const session = await capability.openSession({ instance: "alpha", workspace: "/repo", ctxId: "ctx-valid" });
        const progress: JsonValue[] = [];
        const call = session.callTool("file_read", { path: "file" }, { operationId: "session-op", onProgress: (value) => progress.push(value) });
        const settled = Promise.allSettled([call]);
        const approvalId = await pendingApproval.promise;
        assert.equal(executions, 0);
        await alpha.approval.decideApproval(approvalId, { decision, decidedBy: "cli" });
        const [outcome] = await settled;
        assert.equal(outcome!.status, decision === "approve" ? "fulfilled" : "rejected");
        assert.equal(executions, decision === "approve" ? 1 : 0);
        assert.deepEqual(progress, decision === "approve" ? [{ step: "executed" }] : []);
        assert.equal(released, 1);
        assert.deepEqual(seen, [{ ...boundContext, instance: "alpha", operationId: "session-op" }]);
        const records = await (decision === "approve" ? beta : alpha).audit.api.toolCalls.readQuery();
        assert.equal(records.length, recording === "host" ? 1 : 0);
        assert.deepEqual(records.map((record) => [record.instance, record.status, record.extensionId, record.source, record.ctxId]),
            recording === "host" ? [[decision === "approve" ? "beta" : "alpha", decision === "approve" ? "completed" : "denied", "agent", "extension", "ctx-valid"]] : []);
        await capability.closeAll();
        assert.deepEqual(a.released, a.opened);
        assert.deepEqual(b.opened, []);
    });
}

test("session close aborts pending real Approval and drains hooks before releasing its Workspace", { timeout: 5_000 }, async (t) => {
    const target = await round4Target({}, "worker-a");
    t.after(async () => await target.close());
    const runtime = createToolCallRuntime({ resolveTarget: () => target.tool.target() });
    const worker = workerInstance("worker-a", { runtime });
    const h = await workerSessionTransport(t, [worker.instance]);
    const pendingApproval = barrier<string>();
    registerApprovalToolCallReview(runtime.hooks, {
        async evaluate(input, signal) {
            const result = await target.approval.evaluate(input, signal);
            assert.equal(result.decision, "ask");
            pendingApproval.resolve((result as { request: { approvalId: string } }).request.approvalId);
            return result;
        },
    });
    let released = 0;
    runtime.hooks.registerContributor(() => ({ release() { released++; } }));
    runtime.hooks.registerExecute("file_read", async () => { assert.fail("cancelled Approval must never execute"); });
    worker.setRelease(async () => { assert.equal(released, 1); });
    const capability = new ExtensionWorkerCapabilityControl({ endpoint: h.endpoint, allowed: true, extensionId: "agent", instances: new InstanceRegistry([worker.instance]), recording: "host" });
    const session = await capability.openSession({ workspace: "/repo" });
    const call = session.callTool("file_read", {});
    const rejected = assert.rejects(call, /Approval wait cancelled/u);
    await pendingApproval.promise;
    await session.close();
    await rejected;
    assert.deepEqual(worker.released, worker.opened);
    assert.equal(released, 1);
    const records = await target.audit.api.toolCalls.readQuery();
    assert.deepEqual(records.map((record) => [record.status, record.extensionId]), [["denied", "agent"]]);
    await capability.closeAll();
});

test("Instance close preserves Worker release facilities until session cleanup retry succeeds", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    const opened = await openToolSessionTransport(h.endpoint, "worker-a", openInput(worker, "close-debt"));
    await opened.activate();
    worker.setRelease(async () => { throw new Error("Worker must stay available"); });
    await assert.rejects(worker.instance.close(), /release remains incomplete/u);
    assert.equal(worker.instance.lifecycle.phase, "retiring");
    assert.deepEqual(worker.supervisionClosed, []);
    assert.deepEqual(worker.released, []);
    h.replace([]);
    worker.setRelease(async () => {});
    await worker.instance.close();
    await opened.close();
    assert.deepEqual(worker.released, ["close-debt"]);
    assert.deepEqual(worker.supervisionClosed, ["worker-a"]);
    assert.equal(worker.instance.lifecycle.closed, true);
});

test("Capability retry of an old session never closes a same-name replacement session", { timeout: 5_000 }, async (t) => {
    const old = workerInstance();
    const fresh = workerInstance();
    const h = await workerSessionTransport(t, [old.instance]);
    const instances = new InstanceRegistry([old.instance]);
    const capability = new ExtensionWorkerCapabilityControl({ endpoint: h.endpoint, allowed: true, extensionId: "agent", instances, recording: "caller" });
    const first = await capability.openSession({ workspace: "/old" });
    old.setRelease(async () => { throw new Error("old generation debt"); });
    const warned = deferred();
    t.mock.method(console, "warn", () => warned.resolve());
    const detached = instances.detach("worker-a", old.instance)!;
    const failed = assert.rejects(detached.retirement, /release remains incomplete/u);
    h.replace([]);
    await Promise.all([failed, warned.promise]);
    instances.add(fresh.instance);
    h.replace([fresh.instance]);
    const second = await capability.openSession({ workspace: "/new" });
    await assert.rejects(first.callTool("file_read", {}), /closed/u);
    old.setRelease(async () => {});
    await first.close();
    await old.instance.retire();
    assert.deepEqual(old.released, old.opened);
    assert.deepEqual(fresh.released, []);
    assert.deepEqual(await second.callTool("file_read", { fresh: true }), { input: { fresh: true } });
    await second.close();
    await capability.closeAll();
    assert.deepEqual(fresh.released, fresh.opened);
});

test("failed open retains Instance cleanup debt after caller Stream terminates", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    t.mock.method(console, "warn", () => {});
    worker.setPrepare(async () => { throw new Error("prepare failed after acquiring Workspace"); });
    worker.setRelease(async () => { throw new Error("prepare rollback debt"); });
    await assert.rejects(openToolSessionTransport(h.endpoint, "worker-a", openInput(worker, "failed-open")), /prepare rollback debt/u);
    assert.deepEqual(worker.released, []);
    await assert.rejects(worker.instance.retire(), /release remains incomplete/u);
    worker.setRelease(async () => {});
    await worker.instance.retire();
    assert.deepEqual(worker.released, ["failed-open"]);
    assert.equal(worker.instance.lifecycle.retired, true);
});

test("retired generation rejects activation but still accepts the owning close command", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    const opened = await openToolSessionTransport(h.endpoint, "worker-a", openInput(worker, "pending-activation"));
    worker.instance.lifecycle.beginRetirement();
    await assert.rejects(opened.activate(), /generation is retired/u);
    await assert.rejects(createToolCallIngressTransport(h.endpoint, opened.binding).call("worker-a", "file_read", {}, boundContext), /retired/u);
    await opened.close();
    await worker.instance.retire();
    assert.deepEqual(worker.released, ["pending-activation"]);
    assert.equal(worker.calls.length, 0);
});

test("lost owner Channel preserves failed cleanup and settles the local handle after original retirement", { timeout: 5_000 }, async (t) => {
    const worker = workerInstance();
    const h = await workerSessionTransport(t, [worker.instance]);
    const capability = new ExtensionWorkerCapabilityControl({ endpoint: h.endpoint, allowed: true, extensionId: "agent", instances: new InstanceRegistry([worker.instance]), recording: "caller" });
    const session = await capability.openSession({ workspace: "/repo" });
    const failedCleanup = deferred();
    t.mock.method(console, "warn", () => failedCleanup.resolve());
    worker.setRelease(async () => { throw new Error("disconnected owner debt"); });
    h.endpoint.disconnect();
    await failedCleanup.promise;
    await assert.rejects(session.close(), /closed/u);
    assert.deepEqual(worker.released, []);
    await assert.rejects(worker.instance.retire(), /release remains incomplete/u);
    worker.setRelease(async () => {});
    await worker.instance.retire();
    await capability.closeAll();
    await session.closed;
    assert.deepEqual(worker.released, worker.opened);
    assert.equal(worker.instance.lifecycle.retired, true);
});
