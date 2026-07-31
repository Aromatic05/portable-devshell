import { describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    type ApprovalRequest,
    type InstanceEvent,
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
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(3));
        await store.reconnect();
        for (const type of ["log.appended", "todo.updated", "instance.statusChanged"] as const) {
            stream.push(instanceEvent(type));
        }
        await vi.advanceTimersByTimeAsync(250);

        expect(clients.runtime.readLogs).toHaveBeenCalledOnce();
        expect(clients.todo.get).toHaveBeenCalledTimes(2);
        expect(clients.overview.get).toHaveBeenCalledTimes(2);
        expect(store.state.todos.demo?.revision).toBe(3);
        store.close();
        vi.useRealTimers();
    });

    it("stops overview polling when subscription setup fails", async () => {
        vi.useFakeTimers();
        const clients = fakeClients({ subscribe: async () => { throw new Error("subscribe failed"); } });
        const store = new WebStore(clients, { overviewRefreshIntervalMs: 1_000 });
        const unsubscribe = store.subscribe(() => undefined);

        await store.load();

        expect(store.state.connection).toBe("offline");
        expect(vi.getTimerCount()).toBe(0);
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

    it("enters offline state when initial overview loading fails", async () => {
        const clients = fakeClients();
        clients.overview.get = vi.fn(async () => {
            throw new Error("overview unavailable");
        });

        const store = new WebStore(clients);
        await store.load();

        expect(store.state.connection).toBe("offline");
        expect(store.state.error).toBe("overview unavailable");
    });
});

function fakeClients(
    overrides: { subscribe?: WebClients["runtime"]["subscribe"] } = {},
): WebClients & {
    reconnect: ReturnType<typeof vi.fn>;
    runtime: WebClients["runtime"] & { refresh: ReturnType<typeof vi.fn> };
} {
    const refresh = vi.fn(async () => ({
        lastSeq: 9,
        snapshot: { ...snapshot, lastSeq: 9 },
    }));
    return {
        close() {},
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
            listApprovals: async () => [],
            getApproval: async () => {
                throw new Error("Not used.");
            },
            decideApproval: async () => {
                throw new Error("Not used.");
            },
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
