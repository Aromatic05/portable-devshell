import { describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
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
