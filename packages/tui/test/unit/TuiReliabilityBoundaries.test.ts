import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, type ContextMessageRecord, type JsonValue } from "@portable-devshell/shared";

import {
    TuiAppStore,
    TuiControlSession,
    TuiControlSessionRefresh,
    TuiControlSessionSubscriptions,
    TuiKeyDispatcher,
    TuiRuntimeOperations,
    auditInputText,
    mergeTuiContextMessageList,
} from "../../src/testing.ts";

function snapshot(name: string, lastSeq = 4) {
    return {
        connectionState: "connected" as const,
        daemonState: "running" as const,
        lastSeq,
        name: asInstanceName(name),
        ready: true,
        status: "ready" as const,
    };
}

test("initial refresh keeps healthy instances usable when an auxiliary read fails", async () => {
    const store = new TuiAppStore();
    const clients = {
        artifact: {
            async listShares() { return []; },
            async listTransfers() { return []; },
        },
        config: {
            async get() {
                return {
                    instances: ["alpha", "beta"].map((name) => ({
                        enabled: true,
                        mcp: { enabled: true, path: `/${name}/mcp` },
                        name,
                        provider: "local",
                        workspace: `/workspace/${name}`,
                    })),
                    mcp: { auth: { mode: "none" }, enabled: false },
                };
            },
        },
        contextMessage: { async list() { return []; } },
        instance: {
            async list() {
                return ["alpha", "beta"].map((name) => ({ mcpEnabled: true, name }));
            },
        },
        mcp: {
            async listApprovals() { return []; },
            async status() { return { running: false }; },
        },
        overview: {
            async get() { throw new Error("overview unavailable"); },
        },
        runtime: {
            async readLogs() { return []; },
            async snapshot(instance: string) {
                return { lastSeq: 4, snapshot: snapshot(instance) };
            },
        },
        todo: {
            async get(instance: string) {
                if (instance === "beta") throw new Error("beta todo unavailable");
                return { todo: { items: [], revision: 0, summary: { completed: 0, total: 0 } } };
            },
        },
        tool: {
            async listApprovals() { return []; },
            async listCalls() { return []; },
        },
    } as never;
    const refresh = new TuiControlSessionRefresh({ clients, readTimeoutMs: 100, store });

    const subscriptions = await refresh.refreshAll();

    assert.deepEqual(subscriptions, [
        { fromSeq: 4, instance: "alpha" },
        { fromSeq: 4, instance: "beta" },
    ]);
    assert.equal(store.getState().snapshotsByInstance.alpha?.ready, true);
    assert.equal(store.getState().snapshotsByInstance.beta?.ready, true);
    assert.equal(store.getState().panelErrors["overview:-:overview"]?.message, "overview unavailable");
    assert.match(store.getState().panelErrors["todo:beta:todo"]?.message ?? "", /beta todo unavailable/u);
});

test("late read-model responses cannot overwrite newer state", async () => {
    const store = new TuiAppStore();
    const resolvers: Array<(value: unknown) => void> = [];
    const refresh = new TuiControlSessionRefresh({
        clients: {
            todo: {
                async get() {
                    return await new Promise((resolve) => resolvers.push(resolve));
                },
            },
        } as never,
        readTimeoutMs: 1_000,
        store,
    });

    const first = refresh.refreshTodo("alpha");
    const second = refresh.refreshTodo("alpha");
    resolvers[1]?.({ todo: { items: [], revision: 2, summary: { completed: 0, total: 0 } } });
    await second;
    resolvers[0]?.({ todo: { items: [], revision: 1, summary: { completed: 0, total: 0 } } });
    await first;

    assert.equal(store.getState().todoByInstance.alpha?.revision, 2);
    assert.equal(store.getState().panelErrors["todo:alpha:todo"], undefined);
});

test("authoritative lifecycle snapshots are not rolled back by stale polling", async () => {
    const store = new TuiAppStore();
    const refresh = new TuiControlSessionRefresh({
        clients: {
            contextMessage: { async list() { return []; } },
            runtime: {
                async readLogs() { return []; },
                async snapshot() {
                    return {
                        lastSeq: 9,
                        snapshot: {
                            ...snapshot("alpha", 9),
                            daemonState: "running",
                            status: "ready",
                        },
                    };
                },
            },
            todo: {
                async get() {
                    return { todo: { items: [], revision: 0, summary: { completed: 0, total: 0 } } };
                },
            },
            tool: {
                async listApprovals() { return []; },
                async listCalls() { return []; },
            },
        } as never,
        store,
    });
    refresh.applyAuthoritativeSnapshot({
        ...snapshot("alpha", 10),
        connectionState: "disconnected",
        daemonState: "stopped",
        ready: false,
        status: "stopped",
    });

    const fromSeq = await refresh.refreshRuntimeInstance("alpha");

    assert.equal(fromSeq, 10);
    assert.equal(store.getState().snapshotsByInstance.alpha?.daemonState, "stopped");
    assert.equal(store.getState().snapshotsByInstance.alpha?.status, "stopped");
});

test("a newer full refresh supersedes an older in-flight refresh", async () => {
    const store = new TuiAppStore();
    let releaseFirstPing!: () => void;
    const firstPing = new Promise<void>((resolve) => {
        releaseFirstPing = resolve;
    });
    let pingCalls = 0;
    let configCalls = 0;
    const session = new TuiControlSession({
        clients: {
            artifact: {
                async listShares() { return []; },
                async listTransfers() { return []; },
            },
            close() {},
            config: {
                async get() {
                    configCalls += 1;
                    return {
                        marker: configCalls,
                        instances: [],
                        mcp: { auth: { mode: "none" }, enabled: false },
                    };
                },
            },
            instance: { async list() { return []; } },
            mcp: {
                async listApprovals() { return []; },
                async status() { return { running: false }; },
            },
            overview: {
                async get() {
                    return {
                        activity: [],
                        alerts: [],
                        controller: { pid: 1, uptimeSeconds: 1 },
                        counts: {
                            activeTodos: 0,
                            failedCalls24h: 0,
                            instancesAttention: 0,
                            instancesCritical: 0,
                            instancesReady: 0,
                            instancesTotal: 0,
                            pendingApprovals: 0,
                        },
                        generatedAt: "2026-08-01T00:00:00.000Z",
                        health: "healthy",
                        instances: [],
                        todos: [],
                    };
                },
            },
            service: {
                async ping() {
                    pingCalls += 1;
                    if (pingCalls === 1) await firstPing;
                    return { pong: true };
                },
            },
        } as never,
        readTimeoutMs: 1_000,
        store,
    });

    const initial = session.start();
    await waitFor(() => pingCalls === 1);
    await session.refresh();
    releaseFirstPing();
    await initial;

    assert.equal(store.getState().configView?.marker, 1);
    assert.equal(store.getState().connection.status, "connected");
    await session.stop();
});

test("control bootstrap timeout releases connecting state with an uncertain-outcome error", async () => {
    const store = new TuiAppStore();
    const session = new TuiControlSession({
        clients: {
            close() {},
            service: {
                async ping() { return await new Promise<never>(() => undefined); },
            },
        } as never,
        readTimeoutMs: 10,
        store,
    });

    await session.start();

    assert.equal(store.getState().connection.status, "error");
    assert.match(store.getState().connection.errorMessage ?? "", /timed out locally/u);
    assert.match(store.getState().connection.errorMessage ?? "", /may still complete/u);
    await session.stop();
});

test("context message list replacement preserves terminal states and optimistic pending messages", () => {
    const delivered: ContextMessageRecord = {
        createdAt: "2026-08-01T00:00:00.000Z",
        ctxId: "ctx-1",
        deliveredAt: "2026-08-01T00:00:01.000Z",
        id: "message-1",
        instance: "alpha",
        status: "delivered",
        text: "done",
    };
    const optimistic: ContextMessageRecord = {
        createdAt: "2026-08-01T00:00:02.000Z",
        ctxId: "ctx-1",
        id: "message-2",
        instance: "alpha",
        status: "pending",
        text: "new",
    };
    const stale: ContextMessageRecord = { ...delivered, deliveredAt: undefined, status: "pending" };

    const merged = mergeTuiContextMessageList([delivered, optimistic], [stale]);

    assert.equal(merged.find((message) => message.id === delivered.id)?.status, "delivered");
    assert.equal(merged.some((message) => message.id === optimistic.id), true);
});

test("text input scopes preserve multi-character paste payloads", () => {
    const dispatcher = new TuiKeyDispatcher();
    const paste = "echo pasted text";

    assert.deepEqual(dispatcher.dispatch("search", { input: paste, key: {} }), [
        { text: paste, type: "search.append" },
    ]);
    assert.deepEqual(dispatcher.dispatch("messageComposer", { input: paste, key: {} }), [
        { text: paste, type: "messageComposer.append" },
    ]);
    assert.deepEqual(dispatcher.dispatch("toolForm", { input: paste, key: {} }), [
        { text: paste, type: "toolForm.append" },
    ]);
    assert.deepEqual(dispatcher.dispatch("form", { input: paste, key: {} }), [
        { text: paste, type: "editor.append" },
    ]);
});

test("audit formatting truncates deeply nested values instead of overflowing the stack", () => {
    const root: Record<string, JsonValue> = {};
    let cursor = root;
    for (let index = 0; index < 15_000; index += 1) {
        const next: Record<string, JsonValue> = {};
        cursor.next = next;
        cursor = next;
    }

    const text = auditInputText(root, undefined);

    assert.match(text, /truncated|max depth/u);
    assert.equal(text.length < 210_000, true);
});

test("a committed context message remains successful when the follow-up audit refresh fails", async () => {
    const store = new TuiAppStore();
    const queued: ContextMessageRecord = {
        createdAt: "2026-08-01T00:00:00.000Z",
        ctxId: "ctx-1",
        id: "message-1",
        instance: "alpha",
        status: "pending",
        text: "review this",
    };
    const operations = new TuiRuntimeOperations({
        clients: {
            contextMessage: {
                async queue() { return queued; },
            },
        } as never,
        operationTimeoutMs: 100,
        session: {
            async refreshAudit() { throw new Error("audit refresh failed"); },
        } as never,
        store,
    });

    await operations.queueContextMessage("alpha", "ctx-1", "review this");

    assert.equal(store.getState().contextMessagesByInstance.alpha?.[0]?.id, "message-1");
    assert.equal(store.getState().panelErrors["audit:alpha:operationRefresh"]?.message, "audit refresh failed");
});


test("one failed instance subscription retries without closing healthy streams", async () => {
    const failures: string[] = [];
    const recovered: string[] = [];
    const closed: string[] = [];
    let betaAttempts = 0;
    const manager = new TuiControlSessionSubscriptions({
        currentSequence: () => 4,
        onConnectionClosed: (instance) => closed.push(instance),
        onEvent: () => undefined,
        onGap: async () => undefined,
        onRecovered: (instance) => recovered.push(instance),
        onSubscribeError: async (instance, error) => {
            failures.push(`${instance}:${error instanceof Error ? error.message : String(error)}`);
        },
        random: () => 0,
        retryBaseMs: 5,
        stableAfterMs: 50,
        subscribe: async (instance) => {
            if (instance === "beta" && betaAttempts++ === 0) {
                throw new Error("beta unavailable");
            }
            let streamClosed = false;
            return {
                close() {
                    streamClosed = true;
                },
                async nextMessage() {
                    while (!streamClosed) {
                        await new Promise((resolve) => setTimeout(resolve, 5));
                    }
                    return { kind: "connection.closed" } as const;
                },
            };
        },
    });

    manager.subscribeInstance("alpha", 4);
    manager.subscribeInstance("beta", 4);
    await waitFor(() => recovered.includes("beta"));

    assert.deepEqual(failures, ["beta:beta unavailable"]);
    assert.equal(recovered.includes("alpha"), true);
    assert.equal(manager.size, 2);
    assert.deepEqual(closed, []);
    manager.closeAll();
});

test("a timed-out subscription retry closes a late obsolete stream", async () => {
    let resolveFirst!: (stream: { close(): void; nextMessage(): Promise<never> }) => void;
    const first = new Promise<{ close(): void; nextMessage(): Promise<never> }>((resolve) => {
        resolveFirst = resolve;
    });
    let attempts = 0;
    let lateCloses = 0;
    let recovered = 0;
    const manager = new TuiControlSessionSubscriptions({
        currentSequence: () => 4,
        onConnectionClosed: () => undefined,
        onEvent: () => undefined,
        onGap: async () => undefined,
        onRecovered: () => { recovered += 1; },
        onSubscribeError: async () => undefined,
        random: () => 0,
        retryBaseMs: 5,
        stableAfterMs: 50,
        subscribeTimeoutMs: 10,
        subscribe: async () => {
            attempts += 1;
            if (attempts === 1) return await first;
            return {
                close() {},
                async nextMessage() { return await new Promise<never>(() => undefined); },
            };
        },
    });

    manager.subscribeInstance("alpha", 4);
    await waitFor(() => recovered === 1);
    resolveFirst({
        close() { lateCloses += 1; },
        async nextMessage() { return await new Promise<never>(() => undefined); },
    });
    await waitFor(() => lateCloses === 1);

    assert.equal(attempts >= 2, true);
    assert.equal(manager.size, 1);
    manager.closeAll();
});

test("runtime commands time out and leave the running state", async () => {
    const store = new TuiAppStore();
    store.replaceInstances([{
        defaultWorkspace: "/workspace/alpha",
        enabled: true,
        mcpEnabled: false,
        name: "alpha",
        provider: "local",
    }]);
    const operations = new TuiRuntimeOperations({
        clients: {
            runtime: {
                async start() { return await new Promise<never>(() => undefined); },
            },
        } as never,
        operationTimeoutMs: 15,
        session: {
            applyAuthoritativeSnapshot(value: never) {
                store.replaceSnapshot(value);
            },
        } as never,
        store,
    });

    await operations.runInstanceAction("start", "alpha");

    const command = store.getState().commandRecords[0];
    assert.equal(command?.status, "failed");
    assert.match(command?.error?.message ?? "", /timed out/u);
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
