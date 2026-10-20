import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION, type ExtensionManifest } from "@portable-devshell/extension";
import { nativeCommands, modelCommands, type CliNativeCommandBinding, type CliModelCommandBinding } from "@portable-devshell/extension/cli";
import type { ControlStreamBinding, ControlRouteBinding } from "@portable-devshell/extension/control";
import type { ToolCallRewriteInvocation } from "@portable-devshell/extension/toolcall";
import { createToolCallRuntime, type ControlPortContext, type MessageStream } from "@portable-devshell/shared";
import { ExtensionGeneration } from "../../../../src/extension/registration/Generation.ts";
import { ExtensionRegistrationBuilder, ExtensionRegistrationSet } from "../../../../src/extension/registration/Registration.ts";
import { createControlExtensionPointRegistry } from "../../../../src/extension/registration/Points.ts";
import { ControlExtensionRouteService } from "../../../../src/extension/api/point/control/Dispatch.ts";
import { WebExtensionPageService } from "../../../../src/server/web/extension/page/Service.ts";
import { ToolCallExtensionBinding } from "../../../../src/extension/api/point/toolcall/index.ts";
import { createCliNativeSandboxBinding, createCliModelSandboxBinding } from "../../../../src/extension/api/point/cli/Sandbox.ts";
import type { ExtensionPointSandboxBridge } from "../../../../src/extension/registration/PointRegistry.ts";
import type { ExtensionRegistrationLease } from "../../../../src/extension/Api.ts";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function manifest(extensions: ExtensionManifest["extensions"] = {}): ExtensionManifest {
    return {
        activation: "lazy", apiVersion: EXTENSION_API_VERSION,
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION, capabilities: [],
        entry: "extension.mjs", extensions, hostDependencies: {},
        id: "matrix", name: "Matrix", version: "1.0.0",
    };
}

function generation(dispose = async () => {}) {
    const result = new ExtensionGeneration({ generation: "same-hash", manifest: manifest(),
        registrations: new ExtensionRegistrationSet([]), dispose });
    result.activate();
    return result;
}

const streamDeclaration = { id: "watch", module: "events", operation: "watch", scope: "instance" } as const;

function streamHost(binding: ControlStreamBinding, runtime = generation()) {
    const listeners = new Set<() => void>();
    let releases = 0;
    const service = new ControlExtensionRouteService({
        listDeclarations: (pointId) => pointId === "control.streams" ? [{
            declaration: streamDeclaration, extensionId: "matrix", generation: runtime.generation,
            id: "watch", pointId,
        }] : [],
        onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        acquireRegistration: async () => {
            const lease = runtime.acquire();
            return { extensionId: "matrix", lease: { ...lease, release() { releases++; lease.release(); } },
                registration: { binding, declaration: streamDeclaration, id: "watch", pointId: "control.streams" } };
        },
    });
    return { service, runtime, listeners, releases: () => releases,
        handle: service.modules("instance")[0]!.streams![0]!.handle };
}

function context(instance: string, signal = new AbortController().signal) {
    return { host: instance, peer: "web", requestId: `request-${instance}`, signal,
        subject: { id: `user-${instance}`, kind: "web-session" } } as ControlPortContext;
}

function wire() {
    const frames: unknown[] = [];
    const closed = deferred();
    const cancelled: unknown[] = [];
    let closes = 0;
    return { frames, closed, cancelled, closes: () => closes,
        stream: { send: async (message: unknown) => { frames.push(message); },
            close: async () => { closes++; closed.resolve(); },
            cancel: async (error: unknown) => { cancelled.push(error); closed.resolve(); } } as unknown as MessageStream };
}

test("round3 stream backpressure retains the retiring runtime until the blocked write completes", { timeout: 5000 }, async () => {
    const entered = deferred();
    const write = deferred();
    let disposed = 0;
    const host = streamHost(async (stream, _request, invocation) => {
        await stream.send({ name: "blocked" });
        assert.equal(invocation.signal.aborted, true);
    }, generation(async () => { disposed++; }));
    const transport = wire();
    transport.stream.send = async () => { entered.resolve(); await write.promise; };
    await host.handle(transport.stream, { id: "one", name: "watch" }, context("a"));
    await entered.promise;
    const retiring = host.runtime.retire();
    assert.equal(host.runtime.state, "draining");
    assert.equal(host.runtime.inFlight, 1);
    assert.equal(disposed, 0);
    assert.equal(host.listeners.size, 1);
    write.resolve();
    await retiring;
    assert.equal(disposed, 1);
    assert.equal(host.releases(), 1);
    assert.equal(host.listeners.size, 0);
    assert.equal(transport.closes(), 1);
});

test("round3 simultaneous instance streams isolate subject, cancellation, and listener cleanup", { timeout: 5000 }, async () => {
    const host = streamHost(async (stream, _request, invocation) => {
        const aborted = new Promise<void>((resolve) => invocation.signal.addEventListener("abort", () => resolve(), { once: true }));
        await stream.send({ name: invocation.destination, payload: invocation.subject!.id });
        await aborted;
    });
    const a = wire();
    const b = wire();
    await host.handle(a.stream, { id: "a", name: "watch" }, context("a"));
    await host.handle(b.stream, { id: "b", name: "watch" }, context("b"));
    assert.equal(host.runtime.inFlight, 2);
    await host.service.retireInstance("a");
    assert.deepEqual(a.frames, [{ name: "a", payload: "user-a" }]);
    assert.deepEqual(b.frames, [{ name: "b", payload: "user-b" }]);
    assert.equal(a.closes(), 1);
    assert.equal(b.closes(), 0);
    assert.equal(host.runtime.inFlight, 1);
    assert.equal(host.listeners.size, 1);
    await host.service.retireInstance("b");
    assert.equal(b.closes(), 1);
    assert.equal(host.releases(), 2);
    assert.equal(host.listeners.size, 0);
    await host.runtime.retire();
});

test("round3 already cancelled stream admission never invokes extension code and unlistens", async () => {
    let calls = 0;
    const host = streamHost(async () => { calls++; });
    const abort = new AbortController();
    abort.abort(new Error("peer disconnected before admission"));
    const transport = wire();
    await host.handle(transport.stream, { id: "a", name: "watch" }, context("a", abort.signal));
    await host.service.retireInstance("a");
    assert.equal(calls, 0);
    assert.equal(transport.closes(), 1);
    assert.deepEqual(transport.cancelled, []);
    assert.equal(host.runtime.inFlight, 0);
    assert.equal(host.releases(), 1);
    assert.equal(host.listeners.size, 0);
    await host.runtime.retire();
});

test("round3 stream write rejection cancels once and removes the change listener before reuse", async () => {
    const failure = new Error("write rejected");
    const host = streamHost(async (stream) => { await stream.send({ name: "one" }); });
    const transport = wire();
    transport.stream.send = async () => { throw failure; };
    await host.handle(transport.stream, { id: "a", name: "watch" }, context("a"));
    await transport.closed.promise;
    await host.service.retireInstance("a");
    assert.equal(transport.cancelled.length, 1);
    assert.equal((transport.cancelled[0] as { message: string }).message, "write rejected");
    assert.equal(transport.closes(), 0);
    assert.equal(host.releases(), 1);
    assert.equal(host.listeners.size, 0);
    const next = wire();
    await host.handle(next.stream, { id: "b", name: "watch" }, context("b"));
    await next.closed.promise;
    await host.service.retireInstance("b");
    assert.deepEqual(next.frames, [{ name: "one" }]);
    assert.equal(host.releases(), 2);
    assert.equal(host.listeners.size, 0);
    await host.runtime.retire();
});

test("round3 concurrent route failure does not release another instance's in-flight lease", async () => {
    const gate = deferred();
    const entered = deferred();
    const runtime = generation();
    const failure = new Error("instance a failed");
    const binding: ControlRouteBinding = async (_request, invocation) => {
        if (invocation.destination === "a") { entered.resolve(); await gate.promise; throw failure; }
        return { destination: invocation.destination, user: invocation.subject!.id };
    };
    const service = new ControlExtensionRouteService({
        listDeclarations: (pointId: string) => pointId === "control.routes" ? [{ declaration: {
            id: "read", module: "settings", operation: "read", scope: "instance",
        }, id: "read", extensionId: "matrix", generation: "same-hash", pointId }] : [],
        onChange: () => () => {},
        acquireRegistration: async () => ({ lease: runtime.acquire(), registration: { binding } }),
    } as never);
    const handle = service.modules("instance")[0]!.operations[0]!.handle;
    const pending = handle({ id: "a", name: "read" }, context("a"));
    const rejected = assert.rejects(async () => await pending, failure);
    await entered.promise;
    assert.deepEqual(await handle({ id: "b", name: "read" }, context("b")), { destination: "b", user: "user-b" });
    assert.equal(runtime.inFlight, 1);
    const retired = runtime.retire();
    gate.resolve();
    await rejected;
    await retired;
    assert.equal(runtime.inFlight, 0);
});

test("round3 native and model commands with the same id require independent bindings", async () => {
    const builder = new ExtensionRegistrationBuilder(manifest({
        "cli.native-commands": [{ id: "same", title: "Native" }],
        "cli.model-commands": [{ id: "same", title: "Model" }],
    }), "/unused", createControlExtensionPointRegistry());
    const native = async () => ({ kind: "text" as const, text: "native" });
    const model = async () => ({ kind: "text" as const, text: "model" });
    builder.register(nativeCommands, "same", native);
    await assert.rejects(builder.finalize(), /did not bind it/u);
    builder.register(modelCommands, "same", model);
    const registrations = await builder.finalize();
    assert.equal(registrations.get(nativeCommands.id, "same")!.binding, native);
    assert.equal(registrations.get(modelCommands.id, "same")!.binding, model);
    assert.equal(registrations.list().length, 2);
});

test("round3 native CLI IO interface cannot request model context authority", async () => {
    let writes = 0;
    const bridge: ExtensionPointSandboxBridge = {
        async invokeBinding(pointId, id, _input, options) {
            assert.equal(pointId, "cli.native-commands");
            assert.equal(id, "same");
            await assert.rejects(options!.interfacePort!.request("cli.context.instanceReference", { instance: "b" }), /Unsupported CLI/u);
            await options!.interfacePort!.request("cli.writeStdout", { chunk: "ok" });
            return { kind: "text", text: "done" };
        },
    };
    const binding: CliNativeCommandBinding = createCliNativeSandboxBinding({ kind: "command" },
        { codeDirectory: "/unused", extensionId: "matrix", id: "same" }, bridge);
    assert.deepEqual(await binding([], { localOwner: false, requestId: "native", signal: new AbortController().signal,
        io: { readInput: async () => undefined, requestInput: async () => {}, writeStderr: async () => {},
            writeStdout: async (chunk) => { assert.equal(chunk, "ok"); writes++; } } }), { kind: "text", text: "done" });
    assert.equal(writes, 1);
});

test("round3 model CLI context interface without IO cannot acquire an IO channel", async () => {
    const references: string[] = [];
    const bridge: ExtensionPointSandboxBridge = {
        async invokeBinding(pointId, _id, _input, options) {
            assert.equal(pointId, "cli.model-commands");
            assert.deepEqual(await options!.interfacePort!.request("cli.context.instanceReference", { instance: "b" }),
                { current: false, handle: "b-handle" });
            await assert.rejects(options!.interfacePort!.request("cli.writeStdout", { chunk: "escape" }), /Unsupported CLI/u);
            return { kind: "text", text: "done" };
        },
    };
    const binding: CliModelCommandBinding = createCliModelSandboxBinding({ kind: "command" },
        { codeDirectory: "/unused", extensionId: "matrix", id: "same" }, bridge);
    await binding([], { instance: "a", workspace: "/a", requestId: "model", signal: new AbortController().signal,
        context: { instanceReference: async (instance) => { references.push(instance); return { current: false, handle: "b-handle" }; } } });
    assert.deepEqual(references, ["b"]);
});

test("round3 page read pins the old same-hash runtime and returns a detached snapshot", async () => {
    const entered = deferred();
    const finish = deferred();
    const disposed: string[] = [];
    const old = generation(async () => { disposed.push("old"); });
    const fresh = generation(async () => { disposed.push("fresh"); });
    let current = old;
    const snapshot = { tables: [{ id: "table", columns: [{ id: "col", label: "Column" }],
        rows: [{ id: "row", cells: { col: { text: "old" } } }] }] };
    const service = new WebExtensionPageService({
        listDeclarations: () => [],
        acquireRegistration: async () => {
            const selected = current;
            return { lease: selected.acquire(), registration: { binding: async () => {
                if (selected === old) { entered.resolve(); await finish.promise; return snapshot; }
                return { tables: [] };
            } } };
        },
    } as never);
    const pending = service.invoke("page", { kind: "read" }, { requestId: "old", signal: new AbortController().signal });
    await entered.promise;
    current = fresh;
    const retired = old.retire();
    assert.deepEqual(await service.invoke("page", { kind: "read" }, { requestId: "fresh", signal: new AbortController().signal }), { tables: [] });
    assert.equal(old.inFlight, 1);
    assert.deepEqual(disposed, []);
    finish.resolve();
    const result = await pending;
    await retired;
    snapshot.tables[0]!.rows[0]!.cells.col.text = "mutated";
    assert.equal(result.tables[0]!.rows[0]!.cells.col!.text, "old");
    assert.equal(fresh.state, "active");
    assert.deepEqual(disposed, ["old"]);
    await fresh.retire();
});

test("round3 invalid page response releases a draining generation without disposing its replacement", async () => {
    const entered = deferred();
    const finish = deferred();
    const old = generation();
    const fresh = generation();
    const service = new WebExtensionPageService({ listDeclarations: () => [],
        acquireRegistration: async () => ({ lease: old.acquire(), registration: { binding: async () => {
            entered.resolve(); await finish.promise;
            return { tables: [{ id: "bad", columns: [{ id: "col", label: "Column" }],
                rows: [{ id: "row", cells: { col: { text: "link", href: "javascript:alert(1)" } } }] }] };
        } } }),
    } as never);
    const pending = service.invoke("page", { kind: "read" }, { requestId: "bad", signal: new AbortController().signal });
    const rejection = assert.rejects(pending, /cell href protocol/u);
    await entered.promise;
    const retired = old.retire();
    finish.resolve();
    await rejection;
    await retired;
    assert.equal(old.inFlight, 0);
    assert.equal(old.state, "disposed");
    assert.equal(fresh.state, "active");
    await fresh.retire();
});

test("round3 partial toolcall acquisition failure releases reviews and rewrites in reverse order", async () => {
    const releases: string[] = [];
    const failure = new Error("second rewrite activation failed");
    let dispatches = 0;
    const runtime = createToolCallRuntime({ resolveTarget: () => ({ dispatch: async () => { dispatches++; return {}; } }) });
    const binding = new ToolCallExtensionBinding({
        listDeclarations: (pointId: string) => (pointId === "toolcall.review" ? ["review"] : ["rewrite-a", "rewrite-b"])
            .map((id) => ({ id, extensionId: "matrix", declaration: { id, hook: id } })),
        acquireRegistration: async (_pointId: string, id: string) => {
            if (id === "rewrite-b") throw failure;
            return { extensionId: "matrix", lease: { release: () => { releases.push(id); } },
                registration: { binding: async () => ({ decision: "continue" }) } };
        },
    } as never);
    binding.install(runtime.hooks);
    try {
        await assert.rejects(runtime.api.call("a", "bash_run", {}, { source: "mcp" }), failure);
        assert.deepEqual(releases, ["rewrite-a", "review"]);
        assert.equal(dispatches, 0);
    } finally { runtime.close(); }
});

test("round3 outbound rewrite that faults after starting is never replayed on a fresh binding", async () => {
    const retired = new AbortController();
    const entered = deferred();
    const finish = deferred();
    const failure = new Error("masking crashed after entering hook");
    let acquisitions = 0;
    let outbound = 0;
    let dispatches = 0;
    let releases = 0;
    const runtime = createToolCallRuntime({ resolveTarget: () => ({ dispatch: async (request) => {
        dispatches++;
        const result = await request.hooks.rewrite({ callId: request.callId, direction: "outbound",
            value: { ...request.value, kind: "result", payload: { raw: "secret" } } });
        return result.payload;
    } }) });
    new ToolCallExtensionBinding({
        listDeclarations: (pointId: string) => pointId === "toolcall.rewrite" ? [{ id: "mask", extensionId: "matrix", declaration: { id: "mask", hook: "100-mask" } }] : [],
        acquireRegistration: async () => {
            acquisitions++;
            return { extensionId: "matrix", lease: { retirementSignal: retired.signal, release: () => { releases++; } },
                registration: { binding: async (input: ToolCallRewriteInvocation) => {
                    if (input.direction === "outbound") { outbound++; entered.resolve(); await finish.promise; throw failure; }
                    return input.value;
                } } };
        },
    } as never).install(runtime.hooks);
    try {
        const pending = runtime.api.call("a", "bash_run", {}, { source: "mcp" });
        const rejection = assert.rejects(pending, failure);
        await entered.promise;
        retired.abort();
        finish.resolve();
        await rejection;
        assert.equal(acquisitions, 1);
        assert.equal(outbound, 1);
        assert.equal(dispatches, 1);
        assert.equal(releases, 1);
    } finally { runtime.close(); }
});

test("pending admission retirement closes promptly, releases a late old-runtime lease, and preserves fresh and unrelated streams", { timeout: 5000 }, async () => {
    const acquiring = deferred();
    const acquired = deferred<ExtensionRegistrationLease>();
    const old = generation();
    const fresh = generation();
    const oldLease = old.acquire();
    const listeners = new Set<() => void>();
    const invocations: string[] = [];
    let acquisitions = 0;
    const binding: ControlStreamBinding = async (_stream, _request, invocation) => {
        invocations.push(invocation.destination);
        await new Promise<void>((resolve) => invocation.signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const registration = { binding, declaration: streamDeclaration, id: "watch", pointId: "control.streams" };
    const service = new ControlExtensionRouteService({
        listDeclarations: (pointId) => pointId === "control.streams" ? [{ ...registration, extensionId: "matrix", generation: "same-hash" }] : [],
        onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        acquireRegistration: async () => {
            acquisitions++;
            if (acquisitions === 1) { acquiring.resolve(); return await acquired.promise; }
            return { extensionId: "matrix", registration, lease: fresh.acquire() };
        },
    });
    const handle = service.modules("instance")[0]!.streams![0]!.handle;
    const pendingWire = wire();
    const otherWire = wire();
    const freshWire = wire();
    const pending = handle(pendingWire.stream, { id: "old", name: "watch" }, context("a"));
    try {
        await acquiring.promise;
        await handle(otherWire.stream, { id: "other", name: "watch" }, context("b"));
        await service.retireInstance("a");
        await pending;
        assert.equal(pendingWire.closes(), 1);
        assert.deepEqual(pendingWire.cancelled, []);
        assert.equal(otherWire.closes(), 0);
        assert.equal(fresh.inFlight, 1);
        const retired = old.retire();
        assert.equal(old.inFlight, 1);
        acquired.resolve({ extensionId: "matrix", registration, lease: oldLease });
        await retired;
        assert.equal(old.inFlight, 0);
        assert.equal(old.state, "disposed");
        assert.equal(pendingWire.closes(), 1);
        assert.deepEqual(invocations, ["b"]);
        assert.equal(listeners.size, 1);
        await handle(freshWire.stream, { id: "fresh", name: "watch" }, context("a"));
        assert.deepEqual(invocations, ["b", "a"]);
        await service.retireInstance("a");
        assert.equal(freshWire.closes(), 1);
        assert.equal(otherWire.closes(), 0);
        assert.equal(fresh.inFlight, 1);
        await service.retireInstance("b");
        assert.equal(otherWire.closes(), 1);
        assert.equal(fresh.inFlight, 0);
        assert.equal(listeners.size, 0);
    } finally {
        acquired.resolve({ extensionId: "matrix", registration, lease: oldLease });
        await pending;
        await service.retireInstance("a");
        await service.retireInstance("b");
        await old.retire();
        await fresh.retire();
    }
});

test("retired pending admission consumes a late activation failure without cancelling the closed stream", { timeout: 5000 }, async () => {
    const acquiring = deferred();
    const acquired = deferred<never>();
    const returned = deferred();
    const service = new ControlExtensionRouteService({
        listDeclarations: (pointId) => pointId === "control.streams" ? [{
            declaration: streamDeclaration, extensionId: "matrix", generation: "same-hash", id: "watch", pointId,
        }] : [],
        onChange: () => { assert.fail("failed admission must not subscribe to changes"); },
        acquireRegistration: async () => {
            acquiring.resolve();
            try { return await acquired.promise; }
            finally { returned.resolve(); }
        },
    });
    const transport = wire();
    const pending = service.modules("instance")[0]!.streams![0]!.handle(transport.stream, { id: "old", name: "watch" }, context("a"));
    await acquiring.promise;
    await service.retireInstance("a");
    await pending;
    assert.equal(transport.closes(), 1);
    acquired.reject(new Error("activation failed after retirement"));
    await returned.promise;
    await service.retireInstance("a");
    assert.equal(transport.closes(), 1);
    assert.deepEqual(transport.cancelled, []);
});

test("an active admission failure reaches its caller and removes the retirement entry", async () => {
    const failure = new Error("activation unavailable");
    const service = new ControlExtensionRouteService({
        listDeclarations: (pointId) => pointId === "control.streams" ? [{ declaration: streamDeclaration, extensionId: "matrix", generation: "same-hash", id: "watch", pointId }] : [],
        onChange: () => { assert.fail("activation failed"); },
        acquireRegistration: async () => { throw failure; },
    });
    const transport = wire();
    await assert.rejects(async () => await service.modules("instance")[0]!.streams![0]!.handle(transport.stream, { id: "failed", name: "watch" }, context("a")), failure);
    await service.retireInstance("a");
    assert.equal(transport.closes(), 0);
    assert.deepEqual(transport.cancelled, []);
});

test("a callback cannot send another frame after retirement and releases its lease after failure", { timeout: 5000 }, async () => {
    const entered = deferred();
    const finish = deferred();
    const host = streamHost(async (stream) => {
        entered.resolve();
        await finish.promise;
        await stream.send({ name: "too-late" });
    });
    const transport = wire();
    try {
        await host.handle(transport.stream, { id: "old", name: "watch" }, context("a"));
        await entered.promise;
        const retiring = host.service.retireInstance("a");
        assert.equal(host.runtime.inFlight, 1);
        finish.resolve();
        await retiring;
        assert.deepEqual(transport.frames, []);
        assert.equal(transport.closes(), 1);
        assert.deepEqual(transport.cancelled, []);
        assert.equal(host.releases(), 1);
        assert.equal(host.runtime.inFlight, 0);
        assert.equal(host.listeners.size, 0);
    } finally {
        finish.resolve();
        await host.service.retireInstance("a");
        await host.runtime.retire();
    }
});
