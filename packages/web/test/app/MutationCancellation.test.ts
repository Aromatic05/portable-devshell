import { expect, it, vi, afterEach } from "vitest";
import { Endpoint, Rpc, Stream, type Channel } from "@portable-devshell/shared";
import { WebDomainSession } from "../../src/app/domain/Session.js";
import { WebStore } from "../../src/state/Store.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
const flush = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
function peer(gate = Promise.resolve()) {
    const server = new Endpoint({ host: "control" });
    const session = new WebDomainSession({
        connectChannel: async (signal) => {
            await gate;
            signal?.throwIfAborted();
            const left = new MemoryChannel(),
                right = new MemoryChannel();
            left.connect(right);
            right.connect(left);
            void server.accept(right);
            return left;
        },
        mcpPollIntervalMs: 0,
        overviewRefreshIntervalMs: 0,
    });
    const store = new WebStore(session, {
        operationTimeoutMs: 10,
        requestTimeoutMs: 10,
    });
    return { server, session, store };
}
const mutations = {
    queue: (s: WebStore) => s.queueContextMessage("alpha", "ctx", "comment"),
    disableContext: (s: WebStore) => s.disableContext("ctx"),
    disableContexts: (s: WebStore) => s.disableContexts(["ctx", "other"]),
    renewContext: (s: WebStore) => s.renewContext("ctx"),
    enable: (s: WebStore) => s.setInstanceEnabled("alpha", true),
    disable: (s: WebStore) => s.setInstanceEnabled("alpha", false),
    delete: (s: WebStore) => s.deleteInstance("alpha"),
    create: (s: WebStore) =>
        s.createInstance({ name: "new", provider: "reverse" }),
    approval: (s: WebStore) => s.decideTool("alpha", "approval", "approve"),
    revokeShare: (s: WebStore) => s.revokeArtifactShare("share"),
    cancelTransfer: (s: WebStore) => s.cancelArtifactTransfer("transfer"),
    config: (s: WebStore) => s.updateConfig({ web: {} }),
    instanceConfig: (s: WebStore) =>
        s.updateConfig({ instance: { instanceName: "alpha", patch: {} } }),
    reverseCode: (s: WebStore) => s.createReverseCode("alpha"),
    rotateToken: (s: WebStore) => s.rotateReverseToken("alpha"),
    revokeToken: (s: WebStore) => s.revokeReverseToken("alpha"),
    restartControl: (s: WebStore) => s.restartControl(),
};
for (const [name, mutate] of Object.entries(mutations)) {
    it(`${name}: timeout before initial connection prevents every later RPC send`, async () => {
        vi.useFakeTimers();
        const gate = deferred<void>();
        const { server, session, store } = peer(gate.promise);
        const received: string[] = [];
        const services = [
            "message",
            "context",
            "instance",
            "approval",
            "artifact",
            "config",
            "connection",
            "server",
        ].flatMap((port) =>
            ["alpha", "@control"].map(
                (host) =>
                    new Rpc(
                        server.bind(port, host),
                        Object.fromEntries(
                            [
                                "queueContextMessage",
                                "disable",
                                "renew",
                                "enableInstance",
                                "disableInstance",
                                "deleteInstance",
                                "createInstance",
                                "snapshot",
                                "decide",
                                "revokeShare",
                                "cancelTransfer",
                                "update",
                                "createCode",
                                "rotateToken",
                                "revokeToken",
                                "restart",
                            ].map((op) => [
                                op,
                                () => {
                                    received.push(op);
                                    return {};
                                },
                            ]),
                        ),
                    ),
            ),
        );
        try {
            const pending = mutate(store);
            await vi.advanceTimersByTimeAsync(11);
            await pending;
            expect(received).toEqual([]);
            gate.resolve();
            await session.messagePreferences.refresh(); // prove the connection really became usable
            await flush();
            expect(received).toEqual([]);
            expect(store.state.error).toMatch(/unknown/i);
        } finally {
            store.close();
            services.forEach((s) => s.close());
            server.close();
        }
    });
}
for (const name of [
    "queue",
    "enable",
    "disable",
    "delete",
    "instanceConfig",
    "reverseCode",
    "rotateToken",
    "revokeToken",
] as const) {
    it(`${name}: releasing a pending instance owner prevents sending to its replacement`, async () => {
        const gate = deferred<void>();
        const { server, session, store } = peer(gate.promise);
        const writes: string[] = [];
        const services = [
            "message",
            "instance",
            "config",
            "connection",
        ].flatMap((port) =>
            ["alpha", "@control"].map(
                (host) =>
                    new Rpc(
                        server.bind(port, host),
                        Object.fromEntries(
                            [
                                "queueContextMessage",
                                "enableInstance",
                                "disableInstance",
                                "deleteInstance",
                                "update",
                                "createCode",
                                "rotateToken",
                                "revokeToken",
                            ].map((op) => [
                                op,
                                () => {
                                    writes.push(op);
                                    return {};
                                },
                            ]),
                        ),
                    ),
            ),
        );
        try {
            const beta = session.instanceSignal("beta");
            const pending = mutations[name](store);
            session.releaseInstance("alpha");
            gate.resolve();
            await pending;
            await session.messagePreferences.refresh();
            await flush();
            expect(writes).toEqual([]);
            expect(beta.aborted).toBe(false);
            expect(session.instanceSignal("alpha").aborted).toBe(false);
        } finally {
            store.close();
            services.forEach((s) => s.close());
            server.close();
        }
    });
}

it("an already accepted queue timeout remains unknown and never replays", async () => {
    vi.useFakeTimers();
    const { server, session, store } = peer();
    const entered = deferred<void>(),
        reply = deferred<unknown>();
    let writes = 0;
    const rpc = new Rpc(server.bind("message", "alpha"), {
        queueContextMessage: async () => {
            writes++;
            entered.resolve();
            return await reply.promise;
        },
    });
    try {
        const pending = store.queueContextMessage("alpha", "ctx", "accepted");
        await entered.promise;
        await vi.advanceTimersByTimeAsync(11);
        expect(await pending).toBe(false);
        expect(store.state.error).toMatch(/unknown/);
        session.releaseInstance("alpha");
        reply.resolve({ id: "old", ctxId: "ctx", text: "accepted" });
        await flush();
        expect(writes).toBe(1);
        expect(session.messages.state.instances.alpha).toBeUndefined();
    } finally {
        store.close();
        rpc.close();
        server.close();
    }
});

for (const replacement of [false, true]) {
    it(`delete cleanup uses authoritative catalog; replacement=${replacement}; beta and all new projections survive`, async () => {
        const { server, session, store } = peer();
        let revision = 1;
        let alpha: string | undefined = "old";
        const entered = deferred<void>(),
            reply = deferred<unknown>();
        const catalog = new Rpc(server.bind("instance", "@control"), {
            snapshotInstances: () => ({
                revision,
                instances: [
                    { name: "beta", incarnation: "beta" },
                    ...(alpha ? [{ name: "alpha", incarnation: alpha }] : []),
                ],
            }),
            deleteInstance: async () => {
                entered.resolve();
                return await reply.promise;
            },
        });
        const streams = new Stream(server.bind("instance", "@control"));
        streams.onOpen(() => {});
        try {
            await session.instances.list();
            const old = session.runtime("alpha"),
                beta = session.runtime("beta");
            const pending = store.deleteInstance("alpha");
            await entered.promise;
            alpha = replacement ? "new" : undefined;
            revision++;
            await session.instances.refresh();
            const runtime = session.runtime("alpha"),
                approval = session.approval("alpha");
            const closes = [
                vi.spyOn(runtime, "close"),
                vi.spyOn(approval, "close"),
                vi.spyOn(session.goals, "release"),
                vi.spyOn(session.toolCalls, "release"),
                vi.spyOn(session.messages, "release"),
                vi.spyOn(session.messageHistory, "release"),
            ];
            expect(runtime).not.toBe(old);
            reply.resolve({});
            await pending;
            await flush();
            closes.forEach((close) => expect(close).not.toHaveBeenCalled());
            expect(session.runtime("alpha")).toBe(runtime);
            expect(session.runtime("beta")).toBe(beta);
        } finally {
            store.close();
            streams.close();
            catalog.close();
            server.close();
        }
    });
}

class MemoryChannel implements Channel {
    closed = false;
    readonly #data = new Set<(data: Uint8Array) => void>();
    readonly #close = new Set<(error?: Error) => void>();
    #peer?: MemoryChannel;
    connect(peer: MemoryChannel) {
        this.#peer = peer;
    }
    async write(data: Uint8Array) {
        if (this.closed || !this.#peer || this.#peer.closed)
            throw new Error("closed");
        const peer = this.#peer,
            copy = Uint8Array.from(data);
        queueMicrotask(() => {
            for (const listener of peer.#data) listener(copy);
        });
    }
    onData(listener: (data: Uint8Array) => void) {
        this.#data.add(listener);
        return () => this.#data.delete(listener);
    }
    onClose(listener: (error?: Error) => void) {
        this.#close.add(listener);
        return () => this.#close.delete(listener);
    }
    close(error?: Error) {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.#close) listener(error);
        this.#peer?.close(error);
    }
}

it("normal delete releases all old projections through the catalog and leaves beta owned", async () => {
    const { server, session, store } = peer();
    let deleted = false;
    const rpc = new Rpc(server.bind("instance", "@control"), {
        snapshotInstances: () => ({
            revision: deleted ? 2 : 1,
            instances: [
                { name: "beta", incarnation: "beta" },
                ...(deleted ? [] : [{ name: "alpha", incarnation: "old" }]),
            ],
        }),
        deleteInstance: () => {
            deleted = true;
            return {};
        },
    });
    const stream = new Stream(server.bind("instance", "@control"));
    stream.onOpen(() => {});
    try {
        await session.instances.list();
        const runtime = session.runtime("alpha"),
            approval = session.approval("alpha"),
            beta = session.runtime("beta");
        const closes = [
            vi.spyOn(runtime, "close"),
            vi.spyOn(approval, "close"),
        ];
        const releases = [
            session.goals,
            session.toolCalls,
            session.messages,
            session.messageHistory,
        ].map((vm) => vi.spyOn(vm, "release"));
        expect(await store.deleteInstance("alpha")).toBe(true);
        closes.forEach((close) => expect(close).toHaveBeenCalledOnce());
        releases.forEach((release) =>
            expect(release).toHaveBeenCalledExactlyOnceWith("alpha"),
        );
        expect(session.runtime("beta")).toBe(beta);
        expect(session.instances.state.instances.map((i) => i.name)).toEqual([
            "beta",
        ]);
    } finally {
        store.close();
        stream.close();
        rpc.close();
        server.close();
    }
});

for (const action of [
    "createShare",
    "startTransfer",
    "approvalDecide",
] as const) {
    it(`${action} VM forwards cancellation to the existing domain RPC`, async () => {
        const gate = deferred<void>();
        const { server, session, store } = peer(gate.promise);
        let writes = 0;
        const rpc = new Rpc(
            server.bind(
                action === "approvalDecide" ? "approval" : "artifact",
                action === "approvalDecide" ? "alpha" : "@control",
            ),
            {
                [action === "approvalDecide" ? "decide" : action]: () => {
                    writes++;
                    return {};
                },
            },
        );
        const controller = new AbortController();
        try {
            const actions = {
                approvalDecide: () =>
                    session
                        .approval("alpha")
                        .decide(
                            "approval",
                            "approve",
                            undefined,
                            controller.signal,
                        ),
                createShare: () =>
                    session.artifact.createShare(
                        "alpha",
                        { handle: "artifact" },
                        controller.signal,
                    ),
                startTransfer: () =>
                    session.artifact.startTransfer(
                        "alpha",
                        {
                            handle: "artifact",
                            operation: "start",
                            targetInstance: "beta",
                            targetPath: "out",
                            targetWorkspace: "/tmp",
                        },
                        controller.signal,
                    ),
            };
            const pending = actions[action]();
            const rejected = expect(pending).rejects.toThrow("cancelled");
            controller.abort(new Error("cancelled"));
            gate.resolve();
            await rejected;
            await session.messagePreferences.refresh();
            await flush();
            expect(writes).toBe(0);
        } finally {
            store.close();
            rpc.close();
            server.close();
        }
    });
}

it("preference write waiting for connection is cancelled when the store closes", async () => {
    const gate = deferred<void>();
    const { server, session, store } = peer(gate.promise);
    let writes = 0;
    const rpc = new Rpc(server.bind("message", "@control"), {
        updatePreferences: () => {
            writes++;
            return {};
        },
    });
    try {
        const pending = store.updateMessagePreferences({
            titles: { context: "title" },
        });
        await flush();
        store.close();
        gate.resolve();
        expect(await pending).toBe(false);
        await flush();
        expect(writes).toBe(0);
    } finally {
        store.close();
        rpc.close();
        server.close();
    }
});
