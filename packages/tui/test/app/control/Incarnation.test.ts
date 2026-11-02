import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
    Endpoint,
    Rpc,
    Stream,
    StreamChannel,
    asInstanceName,
    type InstanceListEnvelope,
    type JsonValue,
} from "@portable-devshell/shared";
import { TuiAppStore } from "../../../src/state/store/App.ts";
import { TuiRuntimeExecutionOperations } from "../../../src/app/operation/Execution.ts";
import { TuiDomainSession } from "../../../src/app/control/Client.ts";
import { TuiDomainReader } from "../../../src/app/control/Reader.ts";
import {
    refreshTuiAudit,
    refreshTuiMessages,
} from "../../../src/app/control/Refresh.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function harness() {
    const server = new Endpoint({ host: "@control" });
    const protocols: Array<Rpc | Stream> = [];
    const opens: Array<{
        instance: string;
        port: string;
        cursor: number;
        closed: boolean;
    }> = [];
    const identities = new Map([
        ["alpha", "A"],
        ["beta", "beta"],
    ]);
    let seq = 99,
        revision = 0;
    let catalogError: Error | undefined;
    let catalogGate: ReturnType<typeof deferred> | undefined;
    const blocked = new Map<string, ReturnType<typeof deferred>>();
    const started = new Set<string>();
    const domains = new TuiDomainSession({
        connectChannel: async () => {
            const upstream = new PassThrough(),
                downstream = new PassThrough();
            const client = new StreamChannel(downstream, upstream);
            void server.accept(new StreamChannel(upstream, downstream));
            return client;
        },
    });
    domains.instanceTransport.snapshotInstances = async () => {
        await catalogGate?.promise;
        if (catalogError !== undefined) throw catalogError;
        const envelope: InstanceListEnvelope = {
            revision: ++revision,
            instances: [...identities].map(([name, incarnation]) => ({
                name,
                incarnation,
                enabled: true,
                mcpEnabled: true,
                snapshot: {
                    name: asInstanceName(name),
                    lastSeq: seq,
                    connectionState: "connected",
                    daemonState: "running",
                    ready: true,
                    status: "ready",
                },
            })),
        };
        return envelope;
    };
    domains.instanceTransport.subscribeInstances = async () => ({
        next: async () => await new Promise<never>(() => {}),
        close() {},
    });
    for (const port of ["process", "approval", "task", "tool", "message"]) {
        const binding = server.bind(port, "*");
        const rpc = new Rpc(binding);
        protocols.push(rpc);
        for (const method of [
            "refresh",
            "snapshot",
            "readLogs",
            "getGoals",
            "listCalls",
            "listContextMessages",
            "listMessageEntries",
        ]) {
            rpc.handle(method, async (_message, context) => {
                const instance = context.local.host,
                    id = identities.get(instance)!,
                    lastSeq = seq;
                const key = `${instance}:${port}:${method}`;
                started.add(key);
                const snapshot = {
                    name: instance,
                    lastSeq,
                    connectionState: "connected",
                    daemonState: "running",
                    ready: true,
                    status: "ready",
                };
                const row = {
                    id,
                    ctxId: id,
                    instance,
                    text: id,
                    status: "pending",
                    kind: "comment",
                    createdAt: "2026-01-01T00:00:00Z",
                };
                const results: Record<string, unknown> = {
                    refresh: { snapshot, lastSeq },
                    snapshot:
                        port === "approval"
                            ? { approvals: [{ approvalId: id }], lastSeq }
                            : { snapshot, lastSeq },
                    readLogs: [{ message: id }],
                    getGoals: { goals: [{ goalId: id }], lastSeq },
                    listCalls: [
                        {
                            callId: id,
                            startedAt: "2026-01-01T00:00:00Z",
                            status: "completed",
                        },
                    ],
                    listContextMessages: { messages: [row], lastSeq },
                    listMessageEntries: { entries: [row], lastSeq },
                };
                await blocked.get(key)?.promise;
                return results[method] as JsonValue;
            });
        }
        const streams = new Stream(binding);
        protocols.push(streams);
        streams.onOpen((stream, method, input, _peer, local) => {
            assert.equal(method, "subscribe");
            const entry = {
                instance: local.host,
                port,
                cursor: (input as { fromSeq: number }).fromSeq,
                closed: false,
            };
            opens.push(entry);
            stream.onCancel(() => {
                entry.closed = true;
            });
            stream.onClose(() => {
                entry.closed = true;
            });
        });
    }
    return {
        domains,
        identities,
        opens,
        blocked,
        started,
        setSeq(value: number) {
            seq = value;
        },
        setError(value?: Error) {
            catalogError = value;
        },
        setCatalogGate(value?: ReturnType<typeof deferred>) {
            catalogGate = value;
        },
        async hydrate(instance: string) {
            await Promise.all([
                domains.runtime(instance).load(),
                domains.approval(instance).load(),
                domains.goals.load(instance),
                domains.toolCalls.load(instance),
                domains.messages.refreshInstance(instance),
                domains.messageHistory.refreshInstance(instance),
            ]);
            domains.messages.ensureInstance(instance);
            domains.messageHistory.ensureInstance(instance);
            await tick();
        },
        close() {
            domains.close();
            for (const protocol of protocols) protocol.close();
            server.close();
        },
    };
}
for (const missing of [false, true]) {
    test(`catalog A->${missing ? "missing->" : ""}B releases all six owners and preserves beta and new cursors`, async (t) => {
        const h = harness();
        t.after(() => h.close());
        const d = h.domains;
        await d.instances.refresh();
        await h.hydrate("alpha");
        await h.hydrate("beta");
        const runtime = d.runtime("alpha"),
            approval = d.approval("alpha");
        const betaRuntime = d.runtime("beta"),
            betaApproval = d.approval("beta");
        const beta = [
            d.goals.state.instances.beta,
            d.toolCalls.state.instances.beta,
            d.messages.state.instances.beta,
            d.messageHistory.state.instances.beta,
        ];
        const oldStreams = h.opens.filter(
            (entry) => entry.instance === "alpha",
        );
        assert.equal(oldStreams.length, 6);
        if (missing) {
            h.identities.delete("alpha");
            await d.instances.refresh();
            assert.equal(d.messages.state.instances.alpha, undefined);
            assert.equal(d.messageHistory.state.instances.alpha, undefined);
        }
        h.identities.set("alpha", "B");
        h.setSeq(2);
        await d.instances.refresh();
        await tick();
        assert.notEqual(d.runtime("alpha"), runtime);
        assert.notEqual(d.approval("alpha"), approval);
        assert.equal(runtime.state.snapshot, undefined);
        assert.deepEqual(approval.state.approvals, []);
        assert.equal(d.goals.state.instances.alpha, undefined);
        assert.equal(d.toolCalls.state.instances.alpha, undefined);
        assert.equal(d.messages.state.instances.alpha, undefined);
        assert.equal(d.messageHistory.state.instances.alpha, undefined);
        assert.deepEqual(
            oldStreams.map((entry) => entry.closed),
            Array(6).fill(true),
        );
        assert.equal(d.runtime("beta"), betaRuntime);
        assert.equal(d.approval("beta"), betaApproval);
        assert.deepEqual(
            [
                d.goals.state.instances.beta,
                d.toolCalls.state.instances.beta,
                d.messages.state.instances.beta,
                d.messageHistory.state.instances.beta,
            ],
            beta,
        );
        assert.deepEqual(
            h.opens
                .filter((entry) => entry.instance === "beta")
                .map((entry) => entry.closed),
            Array(6).fill(false),
        );
        await h.hydrate("alpha");
        assert.equal(
            h.domains.goals.state.instances.alpha?.goals[0]?.goalId,
            "B",
        );
        assert.equal(
            h.domains.toolCalls.state.instances.alpha?.calls[0]?.callId,
            "B",
        );
        assert.equal(
            h.domains.messages.state.instances.alpha?.messages[0]?.id,
            "B",
        );
        assert.equal(
            h.domains.messageHistory.state.instances.alpha?.entries[0]?.id,
            "B",
        );
        assert.deepEqual(
            h.opens
                .filter((entry) => entry.instance === "alpha" && !entry.closed)
                .map((entry) => entry.cursor),
            Array(6).fill(3),
        );
        const before = h.opens.length;
        await d.instances.refresh();
        assert.equal(h.opens.length, before);
    });
}
test("old async reads in all six projections cannot repopulate replacement owners", async (t) => {
    const h = harness();
    t.after(() => h.close());
    const d = h.domains;
    await d.instances.refresh();
    const runtime = d.runtime("alpha"),
        approval = d.approval("alpha");
    const keys = [
        "process:refresh",
        "approval:snapshot",
        "task:getGoals",
        "tool:listCalls",
        "message:listContextMessages",
        "message:listMessageEntries",
    ];
    for (const key of keys) h.blocked.set(`alpha:${key}`, deferred());
    const pending = h.hydrate("alpha");
    for (
        let attempts = 0;
        attempts < 100 && !keys.every((key) => h.started.has(`alpha:${key}`));
        attempts++
    )
        await tick();
    assert.equal(
        keys.every((key) => h.started.has(`alpha:${key}`)),
        true,
    );
    h.identities.set("alpha", "B");
    h.setSeq(2);
    await d.instances.refresh();
    const gates = [...h.blocked.values()];
    h.blocked.clear();
    await h.hydrate("alpha");
    for (const gate of gates) gate.resolve();
    await pending;
    assert.equal(runtime.state.snapshot, undefined);
    assert.deepEqual(approval.state.approvals, []);
    assert.equal(d.runtime("alpha").state.lastSeq, 2);
    assert.equal(d.goals.state.instances.alpha?.goals[0]?.goalId, "B");
    assert.equal(d.toolCalls.state.instances.alpha?.calls[0]?.callId, "B");
    assert.deepEqual(
        d.messages.state.instances.alpha?.messages.map(({ id }) => id),
        ["B"],
    );
    assert.deepEqual(
        d.messageHistory.state.instances.alpha?.entries.map(({ id }) => id),
        ["B"],
    );
});
test("transient catalog reads, errors and unsupported catalogs retain known identity until recovery", async (t) => {
    const h = harness();
    t.after(() => h.close());
    const d = h.domains;
    const initial = d.runtime("alpha");
    await d.instances.refresh();
    assert.equal(d.runtime("alpha"), initial);
    const gate = deferred();
    h.setCatalogGate(gate);
    const refresh = d.instances.refresh();
    assert.equal(d.instances.state.refreshing, true);
    assert.equal(d.runtime("alpha"), initial);
    gate.resolve();
    await refresh;
    h.setCatalogGate();
    h.setError(new Error("offline"));
    await d.instances.refresh();
    assert.equal(d.runtime("alpha"), initial);
    h.setError(
        Object.assign(new Error("unsupported"), { code: "method_not_found" }),
    );
    await d.instances.refresh();
    assert.equal(d.instances.state.supported, false);
    assert.equal(d.runtime("alpha"), initial);
    h.setError();
    h.identities.set("alpha", "B");
    await d.instances.refresh();
    assert.notEqual(d.runtime("alpha"), initial);
});
test("explicit release clears messages and close unsubscribes the catalog bridge", async (t) => {
    const h = harness();
    t.after(() => h.close());
    const d = h.domains;
    await d.instances.refresh();
    await h.hydrate("alpha");
    d.releaseInstance("alpha");
    assert.equal(d.messages.state.instances.alpha, undefined);
    assert.equal(d.messageHistory.state.instances.alpha, undefined);
    await h.hydrate("alpha");
    d.close();
    await tick();
    assert.deepEqual(d.messages.state.instances, {});
    assert.deepEqual(d.messageHistory.state.instances, {});
    assert.deepEqual(d.goals.state.instances, {});
    assert.deepEqual(d.toolCalls.state.instances, {});
    const release = t.mock.method(d, "releaseInstance");
    await d.instances.refresh();
    h.identities.set("alpha", "C");
    await d.instances.refresh();
    assert.equal(release.mock.callCount(), 0);
});

function stubSessionReads(
    d: TuiDomainSession,
    t: import("node:test").TestContext,
) {
    t.mock.method(d.config, "refresh", async () => {});
    t.mock.method(d.context, "refresh", async () => {});
    t.mock.method(d.artifact, "load", async () => {});
    t.mock.method(d.artifact, "refresh", async () => {});
    t.mock.method(d.overview, "refresh", async () => {});
    t.mock.method(d.mcp, "load", async () => {});
    t.mock.method(d.mcp, "refresh", async () => {});
    t.mock.method(d.extension, "refreshCatalogs", async () => {});
    t.mock.method(d.messageHistory, "load", async () => {});
    t.mock.method(d.messagePreferences, "refresh", async () => {});
    t.mock.method(d.server, "connect", async () => {});
    t.mock.method(d.server, "reconnect", async () => {});
}
for (const method of ["load", "reconnect"] as const) {
    test(`${method} reconciles catalog and replacement UI models attach once`, async (t) => {
        const h = harness();
        t.after(() => h.close());
        const d = h.domains;
        stubSessionReads(d, t);
        await d[method]();
        await h.hydrate("alpha");
        const attached: unknown[] = [];
        let updates = 0;
        const reader = new TuiDomainReader(d, (source) => {
            attached.push(source);
            return source.subscribe(() => {
                updates++;
            });
        });
        t.after(() => reader.dispose());
        reader.runtime("alpha");
        reader.approval("alpha");
        const old = d.runtime("alpha");
        h.identities.set("alpha", "B");
        h.setSeq(2);
        await d[method]();
        await h.hydrate("alpha");
        assert.equal(reader.runtime("alpha").lastSeq, 2);
        assert.equal(reader.approval("alpha").lastSeq, 2);
        reader.runtime("alpha");
        reader.approval("alpha");
        assert.notEqual(d.runtime("alpha"), old);
        assert.equal(
            attached.filter((source) => source === d.runtime("alpha")).length,
            1,
        );
        assert.equal(
            attached.filter((source) => source === d.approval("alpha")).length,
            1,
        );
        const before = updates;
        await d.runtime("alpha").refresh();
        assert.ok(updates > before);
    });
    test(`close during ${method} prevents late catalog and polling revival`, async (t) => {
        const h = harness();
        t.after(() => h.close());
        const d = h.domains;
        stubSessionReads(d, t);
        const gate = deferred();
        h.setCatalogGate(gate);
        const overviewStart = t.mock.method(d.overview, "start"),
            authStart = t.mock.method(d.mcp, "start");
        const pending = d[method]();
        await tick();
        d.close();
        gate.resolve();
        await pending;
        assert.deepEqual(d.instances.state.instances, []);
        assert.equal(overviewStart.mock.callCount(), 0);
        assert.equal(authStart.mock.callCount(), 0);
        const connect = t.mock.method(
            d.server,
            method === "load" ? "connect" : "reconnect",
        );
        await d[method]();
        assert.equal(connect.mock.callCount(), 0);
    });
}
test("Audit load released by catalog replacement cannot revive old logs", async (t) => {
    const h = harness();
    t.after(() => h.close());
    const d = h.domains;
    await d.instances.refresh();
    t.mock.method(d.context, "refresh", async () => {});
    const runtime = d.runtime("alpha"),
        logs = t.mock.method(runtime, "readLogs");
    const gate = deferred();
    h.blocked.set("alpha:process:refresh", gate);
    const pending = refreshTuiAudit(d, "alpha");
    for (
        let attempts = 0;
        attempts < 100 && !h.started.has("alpha:process:refresh");
        attempts++
    )
        await tick();
    assert.equal(h.started.has("alpha:process:refresh"), true);
    h.identities.set("alpha", "B");
    await d.instances.refresh();
    gate.resolve();
    await pending;
    assert.equal(logs.mock.callCount(), 0);
    assert.equal(runtime.state.snapshot, undefined);
});

function execution(domains: TuiDomainSession, store: TuiAppStore) {
    return new TuiRuntimeExecutionOperations({
        domains,
        store,
        operationTimeoutMs: 1000,
        reconnect: async () => {},
        clients: {
            artifact: domains.artifactTransport,
            config: domains.configTransport,
            instance: domains.instanceTransport,
            reverse: domains.reverse,
            server: domains.serverTransport,
            task: (instance) => domains.taskTransport(instance),
            tool: (instance) => domains.toolTransport(instance),
        },
    });
}
for (const action of ["start", "stop", "approval"] as const) {
    test(`${action} waiting for old owner load cannot send after catalog replacement`, async (t) => {
        const h = harness();
        t.after(() => h.close());
        const d = h.domains;
        await d.instances.refresh();
        const store = new TuiAppStore(),
            operations = execution(d, store);
        const runtime = d.runtime("alpha"),
            approval = d.approval("alpha");
        const start = t.mock.method(runtime, "start"),
            stop = t.mock.method(runtime, "stop"),
            decide = t.mock.method(approval, "decide");
        const key =
            action === "approval"
                ? "alpha:approval:snapshot"
                : "alpha:process:refresh";
        const gate = deferred();
        h.blocked.set(key, gate);
        const pending =
            action === "approval"
                ? operations.decideApproval("alpha", "A", "approve")
                : operations.runInstanceAction(action, "alpha");
        for (
            let attempts = 0;
            attempts < 100 && !h.started.has(key);
            attempts++
        )
            await tick();
        assert.equal(h.started.has(key), true);
        h.identities.set("alpha", "B");
        await d.instances.refresh();
        gate.resolve();
        await pending;
        assert.equal(start.mock.callCount(), 0);
        assert.equal(stop.mock.callCount(), 0);
        assert.equal(decide.mock.callCount(), 0);
        assert.equal(store.getState().commandRecords[0]?.status, "failed");
    });
}
test("restart retains its captured owner across stop completion and cannot start replacement", async (t) => {
    const h = harness();
    t.after(() => h.close());
    const d = h.domains;
    await d.instances.refresh();
    const store = new TuiAppStore(),
        runtime = d.runtime("alpha");
    const gate = deferred(),
        entered = deferred();
    t.mock.method(runtime, "stop", async () => {
        const snapshot = runtime.state.snapshot!;
        entered.resolve();
        await gate.promise;
        return snapshot;
    });
    const load = t.mock.method(runtime, "load"),
        start = t.mock.method(runtime, "start");
    const pending = execution(d, store).runInstanceAction("restart", "alpha");
    await entered.promise;
    h.identities.set("alpha", "B");
    await d.instances.refresh();
    const replacementStart = t.mock.method(d.runtime("alpha"), "start");
    gate.resolve();
    await pending;
    assert.equal(load.mock.callCount(), 1);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(replacementStart.mock.callCount(), 0);
    assert.equal(store.getState().commandRecords[0]?.status, "failed");
});

test("Messages refresh hydrates replacement at its reset cursor and retains beta subscriptions", async (t) => {
    const h = harness();
    t.after(() => h.close());
    const d = h.domains;
    t.mock.method(d.context, "refresh", async () => {});
    t.mock.method(d.messagePreferences, "refresh", async () => {});
    await refreshTuiMessages(d);
    await tick();
    const old = h.opens.filter((entry) => entry.instance === "alpha");
    assert.equal(old.length, 2);
    h.identities.set("alpha", "B");
    h.setSeq(2);
    await refreshTuiMessages(d);
    await tick();
    assert.deepEqual(
        old.map((entry) => entry.closed),
        [true, true],
    );
    assert.deepEqual(
        d.messages.state.instances.alpha?.messages.map(({ id }) => id),
        ["B"],
    );
    assert.deepEqual(
        d.messageHistory.state.instances.alpha?.entries.map(({ id }) => id),
        ["B"],
    );
    assert.deepEqual(
        h.opens
            .filter((entry) => entry.instance === "alpha" && !entry.closed)
            .map((entry) => entry.cursor),
        [3, 3],
    );
    assert.deepEqual(
        h.opens
            .filter((entry) => entry.instance === "beta")
            .map((entry) => entry.closed),
        [false, false],
    );
});
