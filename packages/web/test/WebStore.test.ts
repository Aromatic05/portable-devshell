import { describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    type InstanceEvent,
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
