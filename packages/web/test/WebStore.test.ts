import { describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    type ApprovalRequest,
    type ContextMessageRecord,
    type InstanceEvent,
    type InstanceRuntimeEnvelope,
    type InstanceSnapshot,
    type OAuthApprovalRequest,
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
        expect(store.state.toolCalls.demo).toEqual([call]);
        expect(await store.queueContextMessage("demo", "ctx-demo", queued.text)).toBe(true);
        expect(clients.contextMessage.queue).toHaveBeenCalledWith("demo", {
            ctxId: "ctx-demo",
            text: queued.text,
        });
        expect(store.state.contextMessages.demo).toEqual([queued]);
        expect(clients.contextMessage.list).toHaveBeenCalledOnce();
        expect(clients.overview.get).toHaveBeenCalledOnce();
    });

    it("uses the server overview as the authoritative operational read model", async () => {
        const clients = fakeClients();
        const overview = { ...operationalOverview(), alerts: [{ detail: "The server classified this alert.", id: "server-alert", kind: "overview.partial" as const, severity: "attention" as const, title: "Server alert" }], health: "critical" as const };
        clients.overview.get = vi.fn(async () => overview);

        const store = new WebStore(clients);
        await store.load();

        expect(store.state.overview).toBe(overview);
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
        expect(subscriptions).toEqual([3, 3]);
        expect(store.state.connection).toBe("online");
    });

    it("abandons an obsolete load when reconnecting", async () => {
        let releaseFirstHello!: () => void;
        const firstHello = new Promise<{ capabilities: string[]; protocolVersion: number }>((resolve) => {
            releaseFirstHello = () => resolve({ capabilities: ["request"], protocolVersion: 1 });
        });
        const subscriptions: number[] = [];
        const clients = fakeClients({
            subscribe: async (_name, fromSeq) => {
                subscriptions.push(fromSeq);
                return pendingStream();
            },
        });
        clients.service.hello = vi.fn()
            .mockReturnValueOnce(firstHello)
            .mockResolvedValue({ capabilities: ["request"], protocolVersion: 1 });
        const store = new WebStore(clients);

        const initialLoad = store.load();
        await Promise.resolve();
        await store.reconnect();
        releaseFirstHello();
        await initialLoad;

        expect(clients.service.hello).toHaveBeenCalledTimes(2);
        expect(subscriptions).toEqual([3]);
        expect(store.state.connection).toBe("online");
        store.close();
    });

    it("does not apply refresh results from before reconnect", async () => {
        vi.useFakeTimers();
        const stream = controllableStream();
        const clients = fakeClients({ subscribe: async () => stream });
        const store = new WebStore(clients);
        await store.load();
        let releaseLogs!: () => void;
        let releaseTodo!: () => void;
        let releaseApprovals!: () => void;
        let releaseOverview!: () => void;
        const oldLogs = new Promise<[]>(resolve => { releaseLogs = () => resolve([]); });
        const oldTodo = new Promise<{ lastSeq: number; todo: { items: []; revision: number; summary: { completed: number; total: number } } }>(resolve => {
            releaseTodo = () => resolve({ lastSeq: 4, todo: { items: [], revision: 2, summary: { completed: 0, total: 0 } } });
        });
        const oldApprovals = new Promise<[]>(resolve => { releaseApprovals = () => resolve([]); });
        const oldOverview = new Promise<ReturnType<typeof operationalOverview>>(resolve => { releaseOverview = () => resolve(operationalOverview()); });
        const currentApproval = {
            approvalId: "current", callId: "call", createdAt: "2026-07-31T00:00:01Z", expiresAt: "2026-07-31T01:00:00Z",
            inputSummary: "current", instance: asInstanceName("demo"), reason: "current", riskLevel: "low" as const,
            source: "web" as const, status: "pending" as const, toolName: "bash_run",
        };
        clients.runtime.readLogs = vi.fn()
            .mockReturnValueOnce(oldLogs)
            .mockResolvedValue([{ at: "2026-07-31T00:00:01Z", instanceName: asInstanceName("demo"), message: "current", seq: 5, stream: "stdout" as const }]);
        clients.todo.get = vi.fn()
            .mockReturnValueOnce(oldTodo)
            .mockResolvedValue({ lastSeq: 5, todo: { items: [], revision: 3, summary: { completed: 0, total: 0 } } });
        clients.tool.listApprovals = vi.fn()
            .mockReturnValueOnce(oldApprovals)
            .mockResolvedValue([currentApproval]);
        clients.overview.get = vi.fn()
            .mockReturnValueOnce(oldOverview)
            .mockResolvedValue({ ...operationalOverview(), generatedAt: "2026-07-31T00:00:02Z" });

        for (const type of ["log.appended", "todo.updated", "approval.requested", "instance.statusChanged"] as const) {
            stream.push(instanceEvent(type));
        }
        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(clients.overview.get).toHaveBeenCalledTimes(1));
        await store.reconnect();
        stream.push(instanceEvent("log.appended"));
        await vi.advanceTimersByTimeAsync(250);
        releaseLogs();
        releaseTodo();
        releaseApprovals();
        releaseOverview();
        await vi.waitFor(() => expect(store.state.logs.demo?.[0]?.message).toBe("current"));

        expect(store.state.todos.demo?.revision).toBe(3);
        expect(store.state.approvals.demo?.[0]?.approvalId).toBe("current");
        expect(store.state.overview?.generatedAt).toBe("2026-07-31T00:00:02Z");
        store.close();
        vi.useRealTimers();
    });

    it("replaces obsolete refresh timers when reconnecting", async () => {
        vi.useFakeTimers();
        const stream = controllableStream();
        const clients = fakeClients({ subscribe: async () => stream });
        const store = new WebStore(clients);
        await store.load();
        clients.runtime.readLogs = vi.fn(async () => []);
        let revision = 2;
        clients.todo.get = vi.fn(async () => ({ lastSeq: 4, todo: { items: [], revision: revision++, summary: { completed: 0, total: 0 } } }));
        clients.overview.get = vi.fn(async () => operationalOverview());

        for (const type of ["log.appended", "todo.updated", "instance.statusChanged"] as const) {
            stream.push(instanceEvent(type));
        }
        await vi.advanceTimersByTimeAsync(0);
        await store.reconnect();
        for (const type of ["log.appended", "todo.updated", "instance.statusChanged"] as const) {
            stream.push(instanceEvent(type));
        }
        await vi.advanceTimersByTimeAsync(250);

        expect(clients.runtime.readLogs).toHaveBeenCalledTimes(2);
        expect(clients.todo.get).toHaveBeenCalledTimes(2);
        expect(clients.overview.get).toHaveBeenCalledTimes(2);
        expect(store.state.todos.demo?.revision).toBe(3);
        store.close();
        vi.useRealTimers();
    });

    it("keeps overview polling while retrying a failed subscription", async () => {
        vi.useFakeTimers();
        const clients = fakeClients({ subscribe: async () => { throw new Error("subscribe failed"); } });
        const store = new WebStore(clients, { overviewRefreshIntervalMs: 1_000 });
        const unsubscribe = store.subscribe(() => undefined);

        await store.load();

        expect(store.state.connection).toBe("online");
        expect(store.state.partialFailures["stream:demo"]).toBe("subscribe failed");
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        unsubscribe();
        store.close();
        vi.useRealTimers();
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

    it("does not apply an old OAuth approval list after reconnecting", async () => {
        const clients = fakeClients();
        let releaseOldList!: () => void;
        const oldApproval = oauthApproval("old");
        clients.mcp.listApprovals = vi.fn(() => new Promise<OAuthApprovalRequest[]>((resolve) => {
            releaseOldList = () => resolve([oldApproval]);
        }));
        clients.mcp.decideApproval = vi.fn(async () => oauthApproval("oauth-1", "approved"));
        const store = new WebStore(clients);
        await store.load();

        const mutation = store.decideOAuth("oauth-1", "approve");
        await vi.waitFor(() => expect(clients.mcp.listApprovals).toHaveBeenCalledOnce());
        await store.reconnect();
        releaseOldList();
        await mutation;

        expect(store.state.oauthApprovals).toEqual([]);
        store.close();
    });

    it("refreshes and resubscribes after stream.gap", async () => {
        let count = 0;
        const subscriptions: number[] = [];
        const clients = fakeClients({
            subscribe: async (_name, fromSeq) => {
                subscriptions.push(fromSeq);
                count += 1;
                return count === 1 ? gapStream() : pendingStream();
            },
        });
        const store = new WebStore(clients);

        await store.load();
        await vi.waitFor(() => expect(subscriptions).toEqual([3, 9]));

        expect(clients.runtime.refresh).toHaveBeenCalledWith("demo");
    });

    it("keeps core data online when one instance todo read fails", async () => {
        const clients = fakeClients();
        clients.todo.get = vi.fn(async () => {
            throw new Error("todo unavailable");
        });

        const store = new WebStore(clients);
        await store.load();

        expect(store.state.connection).toBe("online");
        expect(store.state.instances).toHaveLength(1);
        expect(store.state.partialFailures["todos:demo"]).toBe("todo unavailable");
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

    it("refreshes instance, approval, todo, and overview models after start and stop", async () => {
        const clients = fakeClients();
        let lifecycle = 0;
        clients.runtime.start = vi.fn(async () => {
            lifecycle = 1;
            return { ...snapshot, lastSeq: 4 };
        });
        clients.runtime.stop = vi.fn(async () => {
            lifecycle = 2;
            return { ...snapshot, lastSeq: 5 };
        });
        clients.runtime.refresh = vi.fn(async () => ({ lastSeq: lifecycle + 3, snapshot: { ...snapshot, lastSeq: lifecycle + 3 } }));
        clients.tool.listApprovals = vi.fn(async () => lifecycle === 1 ? [approval("after-start")] : []);
        clients.todo.get = vi.fn(async () => ({ lastSeq: lifecycle + 3, todo: todo(lifecycle + 1) }));
        clients.overview.get = vi.fn(async () => ({ ...operationalOverview(), generatedAt: `2026-07-31T00:00:0${lifecycle}Z` }));
        const store = new WebStore(clients);
        await store.load();

        await store.start("demo");

        expect(store.state.instances[0]?.snapshot.lastSeq).toBe(4);
        expect(store.state.approvals.demo?.[0]?.approvalId).toBe("after-start");
        expect(store.state.todos.demo?.revision).toBe(2);
        expect(store.state.overview?.generatedAt).toBe("2026-07-31T00:00:01Z");

        await store.stop("demo");

        expect(store.state.instances[0]?.snapshot.lastSeq).toBe(5);
        expect(store.state.approvals.demo).toEqual([]);
        expect(store.state.todos.demo?.revision).toBe(3);
        expect(store.state.overview?.generatedAt).toBe("2026-07-31T00:00:02Z");
    });

    it("refreshes approval, todo, and overview models after a tool decision", async () => {
        const clients = fakeClients();
        let decided = false;
        clients.tool.decideApproval = vi.fn(async () => {
            decided = true;
            return decidedToolApproval("pending", "approve");
        });
        clients.tool.listApprovals = vi.fn(async () => decided ? [] : [approval("pending")]);
        clients.todo.get = vi.fn(async () => ({ lastSeq: decided ? 4 : 3, todo: todo(decided ? 2 : 1) }));
        clients.overview.get = vi.fn(async () => ({ ...operationalOverview(), generatedAt: decided ? "2026-07-31T00:00:01Z" : "2026-07-31T00:00:00Z" }));
        const store = new WebStore(clients);
        await store.load();

        await store.decideTool("demo", "pending", "approve");

        expect(store.state.approvals.demo).toEqual([]);
        expect(store.state.todos.demo?.revision).toBe(2);
        expect(store.state.overview?.generatedAt).toBe("2026-07-31T00:00:01Z");
    });

    it("refreshes OAuth approvals and overview after an OAuth decision", async () => {
        const clients = fakeClients();
        let decided = false;
        clients.mcp.status = async () => ({ authMode: "oauth2", oauthReady: true, running: true });
        clients.mcp.decideApproval = vi.fn(async () => {
            decided = true;
            return oauthApproval("oauth-pending", "approved");
        });
        clients.mcp.listApprovals = vi.fn(async () => decided ? [] : [oauthApproval("oauth-pending")]);
        clients.overview.get = vi.fn(async () => ({ ...operationalOverview(), generatedAt: decided ? "2026-07-31T00:00:01Z" : "2026-07-31T00:00:00Z" }));
        const store = new WebStore(clients);
        await store.load();

        await store.decideOAuth("oauth-pending", "approve");

        expect(store.state.oauthApprovals).toEqual([]);
        expect(store.state.overview?.generatedAt).toBe("2026-07-31T00:00:01Z");
    });

    it("does not let an event refresh overwrite the overview fetched after a mutation", async () => {
        vi.useFakeTimers();
        const stream = controllableStream();
        const clients = fakeClients({ subscribe: async () => stream });
        let releaseOldOverview!: () => void;
        const oldOverview = new Promise<ReturnType<typeof operationalOverview>>((resolve) => {
            releaseOldOverview = () => resolve({ ...operationalOverview(), generatedAt: "2026-07-31T00:00:01Z" });
        });
        clients.overview.get = vi.fn()
            .mockResolvedValueOnce(operationalOverview())
            .mockReturnValueOnce(oldOverview)
            .mockResolvedValueOnce({ ...operationalOverview(), generatedAt: "2026-07-31T00:00:02Z" });
        const store = new WebStore(clients);
        await store.load();

        stream.push(instanceEvent("instance.statusChanged"));
        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(clients.overview.get).toHaveBeenCalledTimes(2));
        await store.start("demo");
        releaseOldOverview();
        await vi.runAllTimersAsync();

        expect(store.state.overview?.generatedAt).toBe("2026-07-31T00:00:02Z");
        store.close();
        vi.useRealTimers();
    });

    it("does not let an event approval refresh overwrite a tool decision", async () => {
        const stream = controllableStream();
        const clients = fakeClients({ subscribe: async () => stream });
        const store = new WebStore(clients);
        await store.load();
        let releaseEventApprovals!: () => void;
        const eventApprovals = new Promise<ReturnType<typeof approval>[]>((resolve) => {
            releaseEventApprovals = () => resolve([approval("pending")]);
        });
        clients.tool.listApprovals = vi.fn()
            .mockReturnValueOnce(eventApprovals)
            .mockResolvedValueOnce([]);
        clients.tool.decideApproval = vi.fn(async () => decidedToolApproval("pending", "approve"));

        stream.push(instanceEvent("approval.requested"));
        await vi.waitFor(() => expect(clients.tool.listApprovals).toHaveBeenCalledOnce());
        await store.decideTool("demo", "pending", "approve");
        releaseEventApprovals();
        await Promise.resolve();

        expect(store.state.approvals.demo).toEqual([]);
        store.close();
    });

    it("debounces an overview refresh after a runtime event", async () => {
        vi.useFakeTimers();
        const clients = fakeClients({ subscribe: async () => eventStream() });
        clients.overview.get = vi.fn(async () => operationalOverview());
        const store = new WebStore(clients);
        await store.load();

        await vi.waitFor(() => expect(clients.overview.get).toHaveBeenCalledOnce());
        await vi.runAllTimersAsync();
        await vi.waitFor(() => expect(clients.overview.get).toHaveBeenCalledTimes(2));
        vi.useRealTimers();
    });

    it("refreshes the Todo read model after a Todo stream event", async () => {
        vi.useFakeTimers();
        const clients = fakeClients({ subscribe: async () => todoEventStream() });
        let revision = 1;
        clients.todo.get = vi.fn(async () => ({
            lastSeq: 4,
            todo: {
                items: [{
                    content: "Refresh browser state",
                    id: "task-1",
                    status: "in_progress" as const,
                }],
                revision: revision++,
                summary: { completed: 0, currentItemId: "task-1", total: 1 },
            },
        }));
        const store = new WebStore(clients);

        await store.load();
        expect(store.state.todos.demo?.revision).toBe(1);
        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(clients.todo.get).toHaveBeenCalledTimes(2));

        expect(store.state.todos.demo?.revision).toBe(2);
        store.close();
        vi.useRealTimers();
    });

    it("refreshes tool calls and Context messages after their runtime events", async () => {
        vi.useFakeTimers();
        const stream = controllableStream();
        const clients = fakeClients({ subscribe: async () => stream });
        const store = new WebStore(clients);
        await store.load();
        const call = {
            callId: "event-call",
            ctxId: "ctx-demo",
            inputSummary: "{}",
            instance: asInstanceName("demo"),
            source: "mcp" as const,
            startedAt: "2026-07-31T00:00:02Z",
            status: "completed" as const,
            toolName: "file_read",
        };
        const contextMessage = {
            createdAt: "2026-07-31T00:00:03Z",
            ctxId: "ctx-demo",
            id: "event-message",
            instance: "demo",
            status: "delivered" as const,
            text: "Message delivered.",
        };
        clients.tool.listCalls = vi.fn(async () => [call]);
        clients.contextMessage.list = vi.fn(async () => [contextMessage]);

        stream.push(instanceEvent("toolCall.completed"));
        stream.push(instanceEvent("context.message.delivered"));
        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(store.state.toolCalls.demo).toEqual([call]));
        expect(store.state.contextMessages.demo).toEqual([contextMessage]);

        store.close();
        vi.useRealTimers();
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

    it("clears partial failures after the corresponding stream refresh recovers", async () => {
        vi.useFakeTimers();
        const stream = controllableStream();
        const clients = fakeClients({ subscribe: async () => stream });
        const store = new WebStore(clients);
        await store.load();

        clients.runtime.readLogs = vi.fn()
            .mockRejectedValueOnce(new Error("logs unavailable"))
            .mockResolvedValueOnce([]);
        clients.todo.get = vi.fn()
            .mockRejectedValueOnce(new Error("todos unavailable"))
            .mockResolvedValueOnce({ lastSeq: 5, todo: { items: [], revision: 2, summary: { completed: 0, total: 0 } } });
        clients.tool.listApprovals = vi.fn()
            .mockRejectedValueOnce(new Error("approvals unavailable"))
            .mockResolvedValueOnce([]);
        clients.overview.get = vi.fn()
            .mockRejectedValueOnce(new Error("overview unavailable"))
            .mockResolvedValueOnce({ ...operationalOverview(), generatedAt: "2026-07-31T00:00:01Z" });

        for (const type of ["log.appended", "todo.updated", "approval.requested", "instance.statusChanged"] as const) {
            stream.push(instanceEvent(type));
        }
        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(Object.keys(store.state.partialFailures)).toHaveLength(4));

        for (const type of ["log.appended", "todo.updated", "approval.requested", "instance.statusChanged"] as const) {
            stream.push(instanceEvent(type));
        }
        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(store.state.todos.demo?.revision).toBe(2));

        expect(store.state.logs.demo).toEqual([]);
        expect(store.state.overview?.generatedAt).toBe("2026-07-31T00:00:01Z");
        expect(store.state.partialFailures).toEqual({});
        store.close();
        vi.useRealTimers();
    });

    it("keeps core data online when initial overview loading fails", async () => {
        const clients = fakeClients();
        clients.overview.get = vi.fn(async () => {
            throw new Error("overview unavailable");
        });

        const store = new WebStore(clients);
        await store.load();

        expect(store.state.connection).toBe("online");
        expect(store.state.partialFailures.overview).toBe("overview unavailable");
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
        service: {
            hello: async () => ({
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: 1,
            }),
            status: async () => ({ instanceCount: 1, ok: true }),
        },
        instance: {
            list: async () => [{ mcpEnabled: true, name: "demo", snapshot }],
        },
        overview: { get: async () => operationalOverview() },
        tool: {
            listCalls: async () => [],
            listApprovals: async () => [],
            getApproval: async () => {
                throw new Error("Not used.");
            },
            decideApproval: async () => {
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
        },
        mcp: {
            status: async () => ({ authMode: "none", oauthReady: false, running: true }),
            listApprovals: async () => [],
            decideApproval: async () => {
                throw new Error("Not used.");
            },
        },
        runtime: {
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

function approval(approvalId: string): ApprovalRequest {
    return {
        approvalId,
        callId: "call",
        createdAt: "2026-07-31T00:00:00Z",
        expiresAt: "2026-07-31T01:00:00Z",
        inputSummary: approvalId,
        instance: asInstanceName("demo"),
        reason: approvalId,
        riskLevel: "low" as const,
        source: "web" as const,
        status: "pending" as const,
        toolName: "bash_run",
    };
}

function decidedToolApproval(
    approvalId: string,
    decision: "approve" | "deny",
): ApprovalRequest {
    return {
        ...approval(approvalId),
        decision: {
            approvalId,
            decidedAt: "2026-07-31T00:00:01Z",
            decidedBy: "web",
            decision,
        },
        status: decision === "approve" ? "approved" : "denied",
    };
}

function oauthApproval(
    approvalId: string,
    status: OAuthApprovalRequest["status"] = "pending",
): OAuthApprovalRequest {
    return {
        approvalId,
        clientId: "client-id",
        clientName: "Web client",
        createdAt: "2026-07-31T00:00:00Z",
        expiresAt: "2026-07-31T01:00:00Z",
        kind: "authorization",
        redirectUris: ["https://client.example/callback"],
        requestedResources: ["portable-devshell"],
        requestedScopes: ["mcp"],
        status,
        ...(status === "pending"
            ? {}
            : {
                  decidedAt: "2026-07-31T00:00:01Z",
                  decidedBy: "web" as const,
              }),
    };
}

function todo(revision: number) {
    return { items: [], revision, summary: { completed: 0, total: 0 } };
}

function pendingStream(): WebRuntimeStream {
    return {
        close() {},
        next: async () => await new Promise<never>(() => undefined),
    } as unknown as WebRuntimeStream;
}

function gapStream(): WebRuntimeStream {
    return {
        close() {},
        next: async () => ({ kind: "gap" }),
    } as unknown as WebRuntimeStream;
}

function eventStream(): WebRuntimeStream {
    let emitted = false;
    return {
        close() {},
        next: async () => {
            if (!emitted) {
                emitted = true;
                return { kind: "event", event: { at: "2026-07-31T00:00:00Z", instanceName: asInstanceName("demo"), seq: 4, type: "instance.statusChanged" } };
            }
            return await new Promise<never>(() => undefined);
        },
    } as unknown as WebRuntimeStream;
}

function todoEventStream(): WebRuntimeStream {
    let emitted = false;
    return {
        close() {},
        next: async () => {
            if (!emitted) {
                emitted = true;
                return { kind: "event", event: { at: "2026-07-31T00:00:00Z", instanceName: asInstanceName("demo"), seq: 4, type: "todo.updated" } };
            }
            return await new Promise<never>(() => undefined);
        },
    } as unknown as WebRuntimeStream;
}

function controllableStream(): WebRuntimeStream & { push(event: InstanceEvent): void } {
    const queued: InstanceEvent[] = [];
    let resolveNext: ((value: { event: InstanceEvent; kind: "event" }) => void) | undefined;
    return {
        close() {},
        next: async () => {
            const event = queued.shift();
            if (event !== undefined) return { event, kind: "event" as const };
            return await new Promise<{ event: InstanceEvent; kind: "event" }>((resolve) => {
                resolveNext = resolve;
            });
        },
        push(event) {
            if (resolveNext !== undefined) {
                const resolve = resolveNext;
                resolveNext = undefined;
                resolve({ event, kind: "event" });
                return;
            }
            queued.push(event);
        },
    } as WebRuntimeStream & { push(event: InstanceEvent): void };
}

function instanceEvent(type: InstanceEvent["type"]): InstanceEvent {
    return { at: "2026-07-31T00:00:00Z", instanceName: asInstanceName("demo"), seq: 4, type };
}

describe("WebStore recovery and consistency", () => {
    it("keeps core data online when Overview is unavailable", async () => {
        const clients = fakeClients();
        clients.overview.get = vi.fn(async () => { throw new Error("overview unavailable"); });
        const store = new WebStore(clients);

        await store.load();

        expect(store.state.connection).toBe("online");
        expect(store.state.instances).toHaveLength(1);
        expect(store.state.partialFailures.overview).toBe("overview unavailable");
    });

    it("keeps other instances online and retries a failed subscription", async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const clients = fakeClients({
            subscribe: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error("stream unavailable");
                return pendingStream();
            },
        });
        const store = new WebStore(clients);

        await store.load();
        expect(store.state.connection).toBe("online");
        expect(store.state.partialFailures["stream:demo"]).toBe("stream unavailable");

        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(attempts).toBe(2));
        expect(store.state.partialFailures["stream:demo"]).toBeUndefined();
        store.close();
        vi.useRealTimers();
    });

    it("applies successful instance refresh results independently", async () => {
        const clients = fakeClients();
        clients.runtime.refresh = vi.fn(async () => ({
            lastSeq: 9,
            snapshot: { ...snapshot, lastSeq: 9 },
        }));
        clients.runtime.readLogs = vi.fn(async () => { throw new Error("logs unavailable"); });
        clients.tool.listApprovals = vi.fn(async () => [approval("fresh")]);
        const store = new WebStore(clients);
        await store.load();

        await store.refreshInstance("demo");

        expect(store.state.instances[0]?.snapshot.lastSeq).toBe(9);
        expect(store.state.approvals.demo?.[0]?.approvalId).toBe("fresh");
        expect(store.state.partialFailures["logs:demo"]).toBe("logs unavailable");
    });

    it("fully resynchronizes every instance read model after stream.gap", async () => {
        let subscription = 0;
        const clients = fakeClients({
            subscribe: async () => (++subscription === 1 ? gapStream() : pendingStream()),
        });
        const reads = {
            contexts: 0,
            logs: 0,
            toolCalls: 0,
            todos: 0,
        };
        clients.contextMessage.list = vi.fn(async () => {
            reads.contexts += 1;
            return [];
        });
        clients.runtime.readLogs = vi.fn(async () => {
            reads.logs += 1;
            return [];
        });
        clients.tool.listCalls = vi.fn(async () => {
            reads.toolCalls += 1;
            return [];
        });
        clients.todo.get = vi.fn(async () => {
            reads.todos += 1;
            return { lastSeq: 9, todo: todo(reads.todos) };
        });
        const store = new WebStore(clients);

        await store.load();
        await vi.waitFor(() => expect(subscription).toBe(2));

        expect(reads).toEqual({ contexts: 2, logs: 2, toolCalls: 2, todos: 2 });
    });

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

    it("does not downgrade a delivered Context message with an older queue response", async () => {
        const clients = fakeClients();
        let release!: () => void;
        clients.contextMessage.queue = vi.fn(() => new Promise<ContextMessageRecord>((resolve) => {
            release = () => resolve({
                createdAt: "2026-07-31T00:00:00Z",
                ctxId: "ctx-demo",
                id: "message-1",
                instance: "demo",
                status: "pending" as const,
                text: "Continue.",
            });
        }));
        const store = new WebStore(clients);
        await store.load();

        const queue = store.queueContextMessage("demo", "ctx-demo", "Continue.");
        store.state.contextMessages.demo = [{
            createdAt: "2026-07-31T00:00:00Z",
            ctxId: "ctx-demo",
            deliveredAt: "2026-07-31T00:00:01Z",
            id: "message-1",
            instance: "demo",
            status: "delivered",
            text: "Continue.",
        }];
        release();
        await queue;

        expect(store.state.contextMessages.demo?.[0]?.status).toBe("delivered");
    });

    it("uses the authoritative lifecycle response even when follow-up reads fail", async () => {
        const clients = fakeClients();
        clients.runtime.start = vi.fn(async (): Promise<InstanceSnapshot> => ({
            ...snapshot,
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 10,
            ready: true,
            status: "running",
        }));
        clients.runtime.refresh = vi.fn(async () => { throw new Error("refresh unavailable"); });
        const store = new WebStore(clients);
        await store.load();

        await store.start("demo");

        expect(store.state.instances[0]?.snapshot.status).toBe("running");
        expect(store.state.instances[0]?.snapshot.lastSeq).toBe(10);
        expect(store.state.notice).toBe("demo start requested.");
        expect(store.state.partialFailures["instance:demo"]).toBe("refresh unavailable");
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

        expect(store.state.logs.demo?.[0]?.callId).toBe("call-1");
    });
});

describe("WebStore stream and lifecycle guards", () => {
    it("retries a stream that closes after it was established", async () => {
        vi.useFakeTimers();
        let subscriptions = 0;
        const clients = fakeClients({
            subscribe: async () => {
                subscriptions += 1;
                return subscriptions === 1
                    ? ({ close() {}, next: async () => ({ kind: "closed" }) } as unknown as WebRuntimeStream)
                    : pendingStream();
            },
        });
        const store = new WebStore(clients);

        await store.load();
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(subscriptions).toBe(2));

        expect(store.state.connection).toBe("online");
        expect(store.state.partialFailures["stream:demo"]).toBeUndefined();
        store.close();
        vi.useRealTimers();
    });

    it("does not replace a lifecycle response with an older refresh snapshot", async () => {
        const clients = fakeClients();
        clients.runtime.start = vi.fn(async (): Promise<InstanceSnapshot> => ({
            ...snapshot,
            lastSeq: 10,
            status: "running",
        }));
        clients.runtime.refresh = vi.fn(async (): Promise<InstanceRuntimeEnvelope> => ({
            lastSeq: 9,
            snapshot: { ...snapshot, lastSeq: 9, status: "ready" },
        }));
        const store = new WebStore(clients);
        await store.load();

        await store.start("demo");

        expect(store.state.instances[0]?.snapshot.lastSeq).toBe(10);
        expect(store.state.instances[0]?.snapshot.status).toBe("running");
    });
});

describe("WebStore approval decision guards", () => {
    it("does not reintroduce a decided tool approval from a stale list response", async () => {
        const clients = fakeClients();
        clients.tool.listApprovals = vi.fn(async () => [approval("pending")]);
        clients.tool.decideApproval = vi.fn(async () =>
            decidedToolApproval("pending", "approve")
        );
        const store = new WebStore(clients);
        await store.load();

        await store.decideTool("demo", "pending", "approve");

        expect(store.state.approvals.demo).toEqual([]);
    });

    it("does not reintroduce a decided OAuth approval from a stale list response", async () => {
        const clients = fakeClients();
        clients.mcp.status = async () => ({
            authMode: "oauth2",
            oauthReady: true,
            running: true,
        });
        clients.mcp.listApprovals = vi.fn(async () => [oauthApproval("oauth-pending")]);
        clients.mcp.decideApproval = vi.fn(async () =>
            oauthApproval("oauth-pending", "approved")
        );
        const store = new WebStore(clients);
        await store.load();

        await store.decideOAuth("oauth-pending", "approve");

        expect(store.state.oauthApprovals).toEqual([]);
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

        expect(store.state.instances[0]?.snapshot.status).toBe("running");
        expect(store.state.operations["start:demo"]).toBeUndefined();
        expect(store.state.notice).toBe("demo start requested.");
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
        clients.runtime.start = vi.fn(async (_instance, signal) => {
            operationSignal = signal;
            return await new Promise<InstanceSnapshot>(() => undefined);
        });

        const request = store.start("demo");
        await vi.advanceTimersByTimeAsync(100);
        await request;

        expect(store.state.operations["start:demo"]).toBeUndefined();
        expect(operationSignal?.aborted).toBe(true);
        expect(store.state.error).toContain("start:demo timed out after 100ms");
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

    it("does not replace an authoritative lifecycle snapshot with an equal-sequence refresh", async () => {
        const clients = fakeClients();
        clients.runtime.start = vi.fn(async (): Promise<InstanceSnapshot> => ({
            ...snapshot,
            lastSeq: 10,
            status: "running",
        }));
        clients.runtime.refresh = vi.fn(async (): Promise<InstanceRuntimeEnvelope> => ({
            lastSeq: 10,
            snapshot: { ...snapshot, lastSeq: 10, pid: 4242, status: "ready" },
        }));
        const store = new WebStore(clients, { overviewRefreshIntervalMs: 0 });
        await store.load();

        await store.start("demo");
        await vi.waitFor(() => expect(clients.runtime.refresh).toHaveBeenCalled());

        expect(store.state.instances[0]?.snapshot.status).toBe("running");
        expect(store.state.instances[0]?.snapshot.pid).toBe(4242);
        store.close();
    });
});
