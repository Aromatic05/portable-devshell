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
        mcp: {
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
