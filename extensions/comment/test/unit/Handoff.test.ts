import assert from "node:assert/strict";
import test from "node:test";
import type {
    ExtensionInstanceEvent,
    ExtensionInstanceEventWatch,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import { TerminalHandoffWatcher } from "../../src/handoff/Watcher.ts";

test("TerminalHandoffWatcher queues handoff comments only for active contexts matching instance and workspace", async () => {
    const watches = new Map<string, ExtensionInstanceEventWatch>();
    let aborted = false;
    const instanceObserve: ExtensionInstanceObserveCapability = {
        list: async () => [],
        readLogs: async () => [],
        refresh: async (name) => ({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 10,
            name,
            ready: true,
            status: "ready",
        }),
        snapshot: async (name) => ({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 10,
            name,
            ready: true,
            status: "ready",
        }),
        watchEvents: async (name, watch) => {
            watches.set(name, watch);
            await new Promise<void>((resolve) => {
                watch.signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                        resolve();
                    },
                    { once: true },
                );
            });
        },
    };
    const contextObserve: ExtensionContextObserveCapability = {
        list: async () => [
            {
                createdAt: "2026-11-26T00:00:00.000Z",
                ctxId: "ctx-match",
                environments: [{ instance: "alpha", workspace: "/ws/a" }],
                expiresAt: "2026-11-27T00:00:00.000Z",
                lastAccessedAt: "2026-11-26T00:00:00.000Z",
                status: "active",
            },
            {
                createdAt: "2026-11-26T00:00:00.000Z",
                ctxId: "ctx-other-ws",
                environments: [{ instance: "alpha", workspace: "/ws/b" }],
                expiresAt: "2026-11-27T00:00:00.000Z",
                lastAccessedAt: "2026-11-26T00:00:00.000Z",
                status: "active",
            },
            {
                createdAt: "2026-11-26T00:00:00.000Z",
                ctxId: "ctx-stateless",
                environments: [{ instance: "alpha" }],
                expiresAt: "2026-11-27T00:00:00.000Z",
                lastAccessedAt: "2026-11-26T00:00:00.000Z",
                status: "active",
            },
        ],
    };
    const queued: Array<{ ctxId: string; instance: string; text: string }> = [];
    const watcher = new TerminalHandoffWatcher({
        contextObserve,
        instanceObserve,
        queue: async (instance, ctxId, text) => {
            queued.push({ ctxId, instance, text });
        },
        reconnectDelayMs: 50,
    });

    watcher.sync([{ enabled: true, name: "alpha" }]);
    const deadline = Date.now() + 2_000;
    while (!watches.has("alpha") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const watch = watches.get("alpha");
    assert.ok(watch);
    assert.equal(watch.fromSeq, 11);
    assert.deepEqual(watch.eventTypes, ["terminal.controlReleased"]);

    const event: ExtensionInstanceEvent = {
        at: "2026-11-26T00:01:00.000Z",
        data: {
            cols: 120,
            cwd: "./app",
            generation: 1,
            name: "dev-server",
            rows: 36,
            terminalId: "process-1111",
            workspace: "/ws/a",
        },
        instanceName: "alpha",
        seq: 11,
        type: "terminal.controlReleased",
    };
    await watch.onEvent(event);

    assert.deepEqual(
        queued.map((item) => item.ctxId),
        ["ctx-match", "ctx-stateless"],
    );
    assert.match(queued[0]!.text, /\[Terminal handoff\].*"dev-server" \(process-1111\).*120x36.*task_inspect/u);

    watcher.close();
    assert.equal(aborted, true);
});
