import { afterEach, describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    type ContextMessageRecord,
    type InstanceSnapshot,
} from "@portable-devshell/shared/browser";

import type { WebClients, WebRuntimeStream } from "../src/client/WebClients.js";
import { WebStore } from "../src/state/WebStore.js";

const snapshot: InstanceSnapshot = {
    connectionState: "connected",
    daemonState: "running",
    lastSeq: 3,
    name: asInstanceName("demo"),
    ready: true,
    status: "ready",
};

afterEach(() => {
    vi.useRealTimers();
});

describe("WebStore", () => {
    it("does not request OAuth approvals when OAuth is disabled", async () => {
        const clients = fakeClients();
        const listApprovals = vi.fn(async () => []);
        clients.mcp.listApprovals = listApprovals;

        await new WebStore(clients).load();

        expect(listApprovals).not.toHaveBeenCalled();
    });

    it("loads tool calls and queues Context messages through the instance routes", async () => {
        const clients = fakeClients();
        const call = {
            callId: "call-1",
            ctxId: "ctx-demo",
            inputSummary: "{}",
            instance: asInstanceName("demo"),
            source: "mcp" as const,
            startedAt: "2026-07-31T00:00:00Z",
            status: "running" as const,
            toolName: "bash_run",
        };
        const queued = {
            createdAt: "2026-07-31T00:00:01Z",
            ctxId: "ctx-demo",
            id: "message-1",
            instance: "demo",
            status: "pending" as const,
            text: "Continue with the next check.",
        };
        clients.tool.listCalls = vi.fn(async () => [call]);
        clients.contextMessage.list = vi.fn(async () => []);
        clients.contextMessage.queue = vi.fn(async () => queued);
        clients.overview.get = vi.fn(async () => operationalOverview());
        const store = new WebStore(clients);

        await store.load();
        expect(store.state.readModel.instanceState.demo?.toolCalls).toEqual([call]);
        expect(await store.queueContextMessage("demo", "ctx-demo", queued.text)).toBe(true);
        expect(clients.contextMessage.queue).toHaveBeenCalledWith("demo", {
            ctxId: "ctx-demo",
            text: queued.text,
        });
        expect(store.state.readModel.instanceState.demo?.contextMessages).toEqual([queued]);
        expect(clients.contextMessage.list).toHaveBeenCalledTimes(2);
        expect(store.state.readModel.instanceState.demo?.commentCalls).toEqual([]);
        expect(clients.overview.get).toHaveBeenCalledOnce();
    });

    it("automatically advances a queued Comment to delivered after the instance delivery event", async () => {
        const stream = controllableStream();
        const clients = fakeClients({ subscribe: async () => stream });
        const queued: ContextMessageRecord = {
            createdAt: "2026-08-07T00:00:00Z",
            ctxId: "ctx-demo",
            id: "message-delivery",
            instance: "demo",
            status: "sent",
            text: "Continue after the next tool call.",
        };
        const delivered: ContextMessageRecord = {
            ...queued,
            callId: "call-delivery",
            deliveredAt: "2026-08-07T00:00:01Z",
            status: "delivered",
        };
        let messages: ContextMessageRecord[] = [];
        clients.contextMessage.list = vi.fn(async () => messages);
        clients.contextMessage.queue = vi.fn(async () => {
            messages = [queued];
            return queued;
        });
        clients.tool.listCalls = vi.fn(async (_instance, query) =>
            query?.callIds?.includes("call-delivery")
                ? [{
                      callId: "call-delivery",
                      completedAt: "2026-08-07T00:00:01Z",
                      ctxId: "ctx-demo",
                      inputSummary: "{}",
                      instance: asInstanceName("demo"),
                      output: { comment: [queued.text] },
                      source: "mcp" as const,
                      startedAt: "2026-08-07T00:00:00Z",
                      status: "completed" as const,
                      toolName: "bash_run",
                  }]
                : []
        );
        const store = new WebStore(clients, { overviewRefreshIntervalMs: 0 });
        await store.load();

        expect(await store.queueContextMessage("demo", queued.ctxId, queued.text)).toBe(true);
        await vi.waitFor(() =>
            expect(
                store.state.readModel.instanceState.demo?.contextMessages.find(
                    (message) => message.id === queued.id,
                )?.status,
            ).toBe("sent")
        );

        messages = [delivered];
        stream.push({
            event: {
                at: delivered.deliveredAt!,
                data: {
                    callId: delivered.callId!,
                    ctxId: delivered.ctxId,
                    ids: [delivered.id],
                    status: "delivered",
                },
                instanceName: asInstanceName("demo"),
                seq: 4,
                type: "context.message.delivered",
            },
            kind: "event",
        });

        await vi.waitFor(() => {
            const message = store.state.readModel.instanceState.demo?.contextMessages.find(
                (candidate) => candidate.id === queued.id,
            );
            expect(message?.status).toBe("delivered");
            expect(message?.callId).toBe("call-delivery");
            expect(store.state.readModel.instanceState.demo?.commentCalls[0]?.callId).toBe(
                "call-delivery",
            );
        });
        store.close();
    });

    it("uses the server overview as the authoritative operational read model", async () => {
        const clients = fakeClients();
        const overview = { ...operationalOverview(), alerts: [{ detail: "The server classified this alert.", id: "server-alert", kind: "overview.partial" as const, severity: "attention" as const, title: "Server alert" }], health: "critical" as const };
        clients.overview.get = vi.fn(async () => overview);

        const store = new WebStore(clients);
        await store.load();

        expect(store.state.readModel.overview).toBe(overview);
        expect(clients.overview.get).toHaveBeenCalledOnce();
    });

    it("reconnects once and restores bounded subscriptions from the last sequence", async () => {
        const subscriptions: number[] = [];
        const clients = fakeClients({
            subscribe: async (_name, fromSeq) => {
                subscriptions.push(fromSeq);
                return pendingStream();
            },
        });
        const store = new WebStore(clients);

        await store.load();
        await Promise.all([store.reconnect(), store.reconnect()]);

        expect(clients.reconnect).toHaveBeenCalledOnce();
        expect(subscriptions).toEqual([9, 9]);
        expect(store.state.connection).toBe("online");
    });

    it("does not let an old mutation clear a new connection operation", async () => {
        const clients = fakeClients();
        let releaseOld!: () => void;
        let releaseNew!: () => void;
        clients.runtime.stop = vi.fn()
            .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOld = resolve; }))
            .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseNew = resolve; }));
        const store = new WebStore(clients);
        await store.load();

        const oldOperation = store.stop("demo");
        await store.reconnect();
        const newOperation = store.stop("demo");
        releaseOld();
        await oldOperation;

        expect(store.state.operations["stop:demo"]).toBe("pending");
        expect(store.state.notice).toBeUndefined();
        expect(store.state.error).toBeUndefined();
        releaseNew();
        await newOperation;
        expect(store.state.operations["stop:demo"]).toBeUndefined();
        store.close();
    });

    it("does not send duplicate start or stop mutations while an operation is pending", async () => {
        const clients = fakeClients();
        let finish!: () => void;
        clients.runtime.stop = vi.fn(() => new Promise<InstanceSnapshot>((resolve) => {
            finish = () => resolve(snapshot);
        }));
        const store = new WebStore(clients);
        await store.load();

        const first = store.stop("demo");
        const second = store.stop("demo");
        expect(clients.runtime.stop).toHaveBeenCalledOnce();
        expect(store.state.operations["stop:demo"]).toBe("pending");
        finish();
        await Promise.all([first, second]);
        expect(store.state.operations["stop:demo"]).toBeUndefined();
    });

    it("polls overview only while online, visible, and observed", async () => {
        vi.useFakeTimers();
        let visible = true;
        const clients = fakeClients();
        clients.overview.get = vi.fn(async () => operationalOverview());
        const store = new WebStore(clients, {
            isPageVisible: () => visible,
            overviewRefreshIntervalMs: 1_000,
        });
        const unsubscribe = store.subscribe(() => undefined);
        await store.load();

        expect(clients.overview.get).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clients.overview.get).toHaveBeenCalledTimes(2);

        visible = false;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clients.overview.get).toHaveBeenCalledTimes(2);

        visible = true;
        unsubscribe();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clients.overview.get).toHaveBeenCalledTimes(2);
        store.close();
        vi.useRealTimers();
    });
});

function fakeClients(
    overrides: { subscribe?: WebClients["runtime"]["subscribe"] } = {},
): WebClients & {
    reconnect: ReturnType<typeof vi.fn>;
    emitTransportClose(error: Error): void;
    runtime: WebClients["runtime"] & { refresh: ReturnType<typeof vi.fn> };
} {
    const transportListeners = new Set<(error: Error) => void>();
    const refresh = vi.fn(async () => ({
        lastSeq: 9,
        snapshot: { ...snapshot, lastSeq: 9 },
    }));
    return {
        close() {},
        emitTransportClose(error) {
            for (const listener of transportListeners) listener(error);
        },
        onTransportClose(listener) {
            transportListeners.add(listener);
            return () => transportListeners.delete(listener);
        },
        reconnect: vi.fn(async () => undefined),
        artifact: {} as WebClients["artifact"],
        config: {} as WebClients["config"],
        context: {
            disable: async () => {
                throw new Error("Not used.");
            },
            list: async () => [],
            renew: async () => {
                throw new Error("Not used.");
            },
        },
        reverse: {} as WebClients["reverse"],
        service: {
            hello: async () => ({
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: 1,
            }),
            ping: async () => ({ pong: true }),
            restart: async () => ({ accepted: true }),
            status: async () => ({ instanceCount: 1, ok: true }),
        },
        instance: {
            list: async () => [{ mcpEnabled: true, name: "demo", snapshot }],
        } as WebClients["instance"],
        overview: { get: async () => operationalOverview() },
        tool: {
            call: async () => ({}),
            listCalls: async () => [],
            listApprovals: async () => [],
            getApproval: async () => {
                throw new Error("Not used.");
            },
            decideApproval: async () => {
                throw new Error("Not used.");
            },
        },
        terminal: {
            attach: async () => {
                throw new Error("Not used.");
            },
            get: async () => {
                throw new Error("Not used.");
            },
            kill: async () => {
                throw new Error("Not used.");
            },
            list: async () => [],
            open: async () => {
                throw new Error("Not used.");
            },
        },
        contextMessage: {
            list: async () => [],
            queue: async (_instance, input) => ({
                createdAt: "2026-07-31T00:00:00Z",
                id: "message",
                instance: "demo",
                status: "pending",
                ...input,
            }),
        },
        todo: {
            get: async () => ({
                lastSeq: 3,
                todo: { items: [], revision: 1, summary: { completed: 0, total: 0 } },
            }),
            subscribe: async () => pendingStream(),
        },
        mcp: {
            status: async () => ({ authMode: "none", oauthReady: false, running: true }),
            listApprovals: async () => [],
            decideApproval: async () => {
                throw new Error("Not used.");
            },
        },
        runtime: {
            openStart: async () => {
                throw new Error("Not used.");
            },
            snapshot: async () => ({ lastSeq: 3, snapshot }),
            refresh,
            readLogs: async () => [],
            start: async () => snapshot,
            stop: async () => snapshot,
            subscribe: overrides.subscribe ?? (async () => pendingStream()),
        },
    };
}

function operationalOverview() {
    return {
        activity: [], alerts: [], controller: { pid: 1, uptimeSeconds: 1 }, counts: { activeTodos: 0, failedCalls24h: 0, instancesAttention: 0, instancesCritical: 0, instancesReady: 1, instancesTotal: 1, pendingApprovals: 0 }, generatedAt: "2026-07-31T00:00:00Z", health: "healthy" as const, instances: [], todos: [],
    };
}

function pendingStream(): WebRuntimeStream {
    return {
        close() {},
        next: async () => await new Promise<never>(() => undefined),
    } as unknown as WebRuntimeStream;
}

type WebRuntimeMessage = Awaited<ReturnType<WebRuntimeStream["next"]>>;

function controllableStream(): WebRuntimeStream & { push(message: WebRuntimeMessage): void } {
    const queued: WebRuntimeMessage[] = [];
    const waiting: Array<(message: WebRuntimeMessage) => void> = [];
    let closed = false;
    return {
        close() {
            if (closed) return;
            closed = true;
            for (const resolve of waiting.splice(0)) resolve({ kind: "closed" });
        },
        async next() {
            const message = queued.shift();
            if (message !== undefined) return message;
            if (closed) return { kind: "closed" };
            return await new Promise<WebRuntimeMessage>((resolve) => waiting.push(resolve));
        },
        push(message) {
            const resolve = waiting.shift();
            if (resolve === undefined) queued.push(message);
            else resolve(message);
        },
    } as WebRuntimeStream & { push(message: WebRuntimeMessage): void };
}

describe("WebStore recovery and consistency", () => {

    it("returns the result of each Context message operation independently", async () => {
        const clients = fakeClients();
        clients.contextMessage.queue = vi.fn(async (_instance, input) => {
            if (input.ctxId === "ctx-b") throw new Error("queue b failed");
            return {
                createdAt: "2026-07-31T00:00:00Z",
                ctxId: input.ctxId,
                id: input.ctxId,
                instance: "demo",
                status: "pending" as const,
                text: input.text,
            };
        });
        const store = new WebStore(clients);
        await store.load();

        const result = await Promise.all([
            store.queueContextMessage("demo", "ctx-a", "A"),
            store.queueContextMessage("demo", "ctx-b", "B"),
        ]);

        expect(result).toEqual([true, false]);
        expect(store.state.error).toBe("queue b failed");
    });

    it("loads logs with Tool Calls so legacy output is available immediately", async () => {
        const clients = fakeClients();
        clients.runtime.readLogs = vi.fn(async () => [{
            at: "2026-07-31T00:00:01Z",
            callId: "call-1",
            instanceName: asInstanceName("demo"),
            message: "output",
            seq: 4,
            stream: "stdout" as const,
        }]);
        const store = new WebStore(clients);

        await store.load();

        expect(store.state.readModel.instanceState.demo?.logs?.[0]?.callId).toBe("call-1");
    });
});


describe("WebStore operation and transport boundaries", () => {
    it("completes a successful lifecycle operation without waiting for auxiliary reads", async () => {
        const clients = fakeClients();
        const store = new WebStore(clients, {
            requestTimeoutMs: 0,
            overviewRefreshIntervalMs: 0,
        });
        await store.load();
        clients.runtime.start = vi.fn(async (): Promise<InstanceSnapshot> => ({
            ...snapshot,
            lastSeq: 10,
            status: "running",
        }));
        clients.runtime.refresh = vi.fn(async () => await new Promise<never>(() => undefined));
        clients.contextMessage.list = vi.fn(async () => await new Promise<never>(() => undefined));
        clients.overview.get = vi.fn(async () => await new Promise<never>(() => undefined));

        await store.start("demo");

        expect(store.state.readModel.instanceState.demo?.snapshot?.status).toBe("running");
        expect(store.state.operations["start:demo"]).toBeUndefined();
        store.close();
    });

    it("clears a primary operation when its RPC exceeds the operation timeout", async () => {
        vi.useFakeTimers();
        const clients = fakeClients();
        const store = new WebStore(clients, {
            operationTimeoutMs: 100,
            overviewRefreshIntervalMs: 0,
        });
        await store.load();
        let operationSignal: AbortSignal | undefined;
        clients.runtime.start = vi.fn(async (_instance, options) => {
            operationSignal = options?.signal;
            return await new Promise<InstanceSnapshot>(() => undefined);
        });

        const request = store.start("demo");
        await vi.advanceTimersByTimeAsync(100);
        await request;

        expect(store.state.operations["start:demo"]).toBeUndefined();
        expect(operationSignal?.aborted).toBe(true);
        expect(store.state.error).toBeTruthy();
        store.close();
        vi.useRealTimers();
    });

    it("marks the control connection offline when the shared transport closes", async () => {
        const clients = fakeClients();
        const store = new WebStore(clients);
        await store.load();

        clients.emitTransportClose(new Error("WebSocket connection closed."));

        expect(store.state.connection).toBe("offline");
        expect(store.state.error).toBe("WebSocket connection closed.");
        store.close();
    });
});
