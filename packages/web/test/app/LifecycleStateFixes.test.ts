import { afterEach, expect, it, vi } from "vitest";
import {
    Endpoint, Rpc, Stream, type Channel, type MessageStream,
    MessageViewModel, MessageHistoryViewModel,
} from "@portable-devshell/shared";

import { WebDomainSession } from "../../src/app/domain/Session.js";
import { WebStore } from "../../src/state/Store.js";
import { WebTestDomains } from "../support/DomainHarness.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

for (const operation of ["start", "stop", "restart", "approval"] as const) {
    it(`${operation} cannot send its first mutation when a preflight resumes after timeout`, async () => {
        vi.useFakeTimers();
        const domains = new WebTestDomains();
        const preflight = deferred<void>();
        const runtime = domains.domains.runtime("alpha");
        const approval = domains.domains.approval("alpha");
        const load = vi.fn(async (_signal?: AbortSignal) => await preflight.promise);
        runtime.load = load;
        approval.load = load;
        const start = vi.spyOn(runtime, "start");
        const stop = vi.spyOn(runtime, "stop");
        const decide = vi.spyOn(approval, "decide");
        const store = new WebStore(domains.domains, { operationTimeoutMs: 10 });
        try {
            const pending = operation === "approval" ? store.decideTool("alpha", "id", "approve") : store[operation]("alpha");
            await vi.advanceTimersByTimeAsync(11);
            expect(await pending).toBe(false);
            const signal = load.mock.calls[0]?.[0];
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal?.aborted).toBe(true);
            preflight.resolve();
            await flush();
            expect(start).not.toHaveBeenCalled();
            expect(stop).not.toHaveBeenCalled();
            expect(decide).not.toHaveBeenCalled();
        } finally { store.close(); }
    });
}

for (const outcome of ["success", "failure"] as const) {
    it(`batch disable stops new writes after reconnect even if the in-flight write ends in ${outcome}`, async () => {
        const domains = new WebTestDomains();
        const response = deferred<never>();
        const disable = vi.spyOn(domains.domains.context, "disable").mockImplementation(async () => await response.promise);
        const store = new WebStore(domains.domains);
        try {
            const pending = store.disableContexts(["ctx-1", "ctx-2"]);
            await store.reconnect();
            expect(await pending).toBe(false);
            if (outcome === "failure") response.reject(new Error("old connection closed"));
            else response.resolve({} as never);
            await flush();
            expect(disable).toHaveBeenCalledTimes(1);
            expect(disable).toHaveBeenCalledWith("ctx-1", expect.any(AbortSignal));
        } finally { store.close(); }
    });
}

it("timed-out creation preserves the unknown result and cannot start a later reverse enrollment write", async () => {
    vi.useFakeTimers();
    const domains = new WebTestDomains();
    const response = deferred<never>();
    vi.spyOn(domains.domains.instances, "create").mockImplementation(async () => await response.promise);
    const enroll = vi.spyOn(domains.domains.reverse, "createCode");
    const store = new WebStore(domains.domains, { operationTimeoutMs: 10 });
    try {
        const pending = store.createInstance({ name: "alpha", provider: "reverse" });
        await vi.advanceTimersByTimeAsync(11);
        expect((await pending).succeeded).toBe(false);
        const failure = store.state.error;
        expect(failure).toMatch(/unknown|uncertain/i);
        response.resolve({ name: "alpha" } as never);
        await flush();
        expect(enroll).not.toHaveBeenCalled();
        expect(store.state.error).toBe(failure);
    } finally { store.close(); }
});

it("a catalog with a new same-name incarnation releases every old domain owner and message cursor", async () => {
    vi.useFakeTimers();
    const { server, session } = peer();
    let replacement = false, closed = 0;
    const old = { id: "old", ctxId: "ctx", instance: "alpha", text: "old", status: "pending", kind: "comment", createdAt: "2026-01-01T00:00:00Z" };
    const transport = {
        listContextMessages: async () => replacement ? { lastSeq: 0, messages: [] } : { lastSeq: 99, messages: [old] },
        listMessageEntries: async () => replacement ? { lastSeq: 0, entries: [] } : { lastSeq: 99, entries: [old] },
        subscribe: async () => ({ next: async () => await new Promise<never>(() => {}), close() { closed++; } }),
    };
    Object.assign(session, {
        messages: new MessageViewModel({ transport: transport as never }),
        messageHistory: new MessageHistoryViewModel({ transport: transport as never }),
    });
    let catalogStream!: MessageStream;
    const catalogRpc = new Rpc(server.bind("instance", "@control"), {
        snapshotInstances: () => ({ revision: replacement ? 2 : 0, instances: [{ name: "alpha", incarnation: replacement ? "new" : "old" }] }),
    });
    const catalogStreams = new Stream(server.bind("instance", "@control"));
    catalogStreams.onOpen((stream) => { catalogStream = stream; });
    const runtime = session.runtime("alpha"), approval = session.approval("alpha");
    const runtimeClose = vi.spyOn(runtime, "close"), approvalClose = vi.spyOn(approval, "close");
    const goalRelease = vi.spyOn(session.goals, "release"), toolRelease = vi.spyOn(session.toolCalls, "release");
    try {
        await session.instances.list();
        await flush();
        await Promise.all([session.messages.load(["alpha"]), session.messageHistory.load(["alpha"])]);
        expect(session.messages.state.instances.alpha?.lastSeq).toBe(99);
        expect(session.messageHistory.state.instances.alpha?.lastSeq).toBe(99);
        // Delete and recreate fit within the real catalog model's 100ms coalescing window.
        await catalogStream.send({ name: "event", payload: { revision: 1, kind: "registry" } });
        replacement = true;
        await catalogStream.send({ name: "event", payload: { revision: 2, kind: "registry" } });
        await vi.advanceTimersByTimeAsync(100);
        await flush();
        expect(runtimeClose).toHaveBeenCalledOnce();
        expect(approvalClose).toHaveBeenCalledOnce();
        expect(goalRelease).toHaveBeenCalledWith("alpha");
        expect(toolRelease).toHaveBeenCalledWith("alpha");
        expect(closed).toBe(2);
        expect(session.messages.state.instances.alpha).toBeUndefined();
        expect(session.messageHistory.state.instances.alpha).toBeUndefined();
        expect(session.runtime("alpha")).not.toBe(runtime);
        await Promise.all([session.messages.load(["alpha"]), session.messageHistory.load(["alpha"])]);
        expect(session.messages.state.instances.alpha?.messages).toEqual([]);
        expect(session.messageHistory.state.instances.alpha?.entries).toEqual([]);
        expect(session.messages.state.instances.alpha?.lastSeq).toBe(0);
        expect(session.messageHistory.state.instances.alpha?.lastSeq).toBe(0);
    } finally { session.close(); catalogStreams.close(); catalogRpc.close(); server.close(); }
});

function peer() {
    let connects = 0;
    const server = new Endpoint({ host: "control" });
    const session = new WebDomainSession({ connectChannel: async () => {
        connects++;
        const left = new MemoryChannel(), right = new MemoryChannel();
        left.connect(right); right.connect(left);
        void server.accept(right);
        return left;
    }, mcpPollIntervalMs: 0, overviewRefreshIntervalMs: 0 });
    return { server, session, connects: () => connects };
}

it("offline bootstrap then repeated reconnect establishes one Context and Artifact stream and consumes later events", async () => {
    vi.useFakeTimers();
    const { server, session } = peer();
    let revision = 7, seq = 8;
    const contextRpc = new Rpc(server.bind("context", "@control"), { snapshot: () => ({ revision, contexts: [] }) });
    const artifactRpc = new Rpc(server.bind("artifact", "@control"), { snapshot: () => ({ lastSeq: seq, shares: [], transfers: [] }) });
    const contextStreams: MessageStream[] = [], artifactStreams: MessageStream[] = [];
    const contextStream = new Stream(server.bind("context", "@control"));
    const artifactStream = new Stream(server.bind("artifact", "@control"));
    contextStream.onOpen((stream) => { contextStreams.push(stream); });
    artifactStream.onOpen((stream) => { artifactStreams.push(stream); });
    Object.assign(session.server, { connect: async () => { throw new Error("offline"); }, reconnect: async () => {} });
    Object.assign(session.config, { refresh: async () => {} });
    Object.assign(session.instances, { refresh: async () => {} });
    Object.assign(session.extension, { refreshCatalogs: async () => {} });
    Object.assign(session.overview, { refresh: async () => {} });
    Object.assign(session.mcp, { refresh: async () => {} });
    Object.assign(session.messagePreferences, { refresh: async () => {} });
    try {
        await expect(session.load()).rejects.toThrow("offline");
        await session.reconnect();
        await session.reconnect();
        await flush();
        expect(contextStreams).toHaveLength(1);
        expect(artifactStreams).toHaveLength(1);
        revision = 8; seq = 9;
        await contextStreams[0]!.send({ name: "event", payload: { revision, ctxIds: ["ctx"] } });
        await artifactStreams[0]!.send({ name: "event", payload: { seq, instance: "alpha", at: "2026-01-01", type: "artifact.shareRevoked" } });
        await vi.advanceTimersByTimeAsync(100);
        await flush();
        expect(session.context.state.revision).toBe(8);
        expect(session.artifact.state.lastSeq).toBe(9);
    } finally {
        session.close(); contextStream.close(); artifactStream.close(); contextRpc.close(); artifactRpc.close(); server.close();
    }
});

it("Artifact mutation completing across Session.close never reopens the real Endpoint", async () => {
    const { server, session, connects } = peer();
    let reads = 0;
    const service = new Rpc(server.bind("artifact", "@control"), {
        snapshot: () => { reads++; return { lastSeq: 7, shares: [], transfers: [] }; },
        revokeShare: () => ({ revoked: true, shareId: "share" }),
    });
    try {
        await session.artifact.refresh();
        const revoke = session.artifactTransport.revokeShare;
        vi.spyOn(session.artifactTransport, "revokeShare").mockImplementation(async (id) => {
            const result = await revoke(id);
            session.close();
            return result;
        });
        await session.artifact.revokeShare("share");
        expect(connects()).toBe(1);
        expect(reads).toBe(1);
        expect(session.artifact.state.lastSeq).toBe(0);
    } finally { session.close(); service.close(); server.close(); }
});

class MemoryChannel implements Channel {
    closed = false;
    readonly #data = new Set<(data: Uint8Array) => void>();
    readonly #close = new Set<(error?: Error) => void>();
    #peer?: MemoryChannel;
    connect(peer: MemoryChannel) { this.#peer = peer; }
    async write(data: Uint8Array) {
        if (this.closed || !this.#peer || this.#peer.closed) throw new Error("closed");
        const peer = this.#peer, copy = Uint8Array.from(data);
        queueMicrotask(() => { for (const listener of peer.#data) listener(copy); });
    }
    onData(listener: (data: Uint8Array) => void) { this.#data.add(listener); return () => this.#data.delete(listener); }
    onClose(listener: (error?: Error) => void) { this.#close.add(listener); return () => this.#close.delete(listener); }
    close(error?: Error) {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.#close) listener(error);
        this.#peer?.close(error);
    }
}
