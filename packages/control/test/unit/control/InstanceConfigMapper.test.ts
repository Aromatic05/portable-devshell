import assert from "node:assert/strict";
import test from "node:test";
import { createInstance, type WorkerInstance } from "@portable-devshell/core/instance";
import { createTerminalRuntime } from "@portable-devshell/core/terminal";
import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";

test("instance composition keeps configured security mode and starts with no admitted worker", async (t) => {
    const instance = createInstance(normalizeConfigInstanceDraft({
        enabled: true, name: "demo-local", provider: "local", security: { mode: "workspace" },
        env: { DEMO: "1" }, extensions: { model: ["instance"] },
    }), {
        events: {
            cursor: () => 0,
            append: async () => { throw new Error("No event append expected before start."); },
            readFrom: () => ({ kind: "events", events: [], lastSeq: 0 }),
        },
    });
    t.after(async () => { await instance.close(); });
    assert.equal(instance.worker.snapshot().effectiveSecurityMode, "workspace");
    assert.equal(instance.worker.snapshot().ready, false);
    assert.equal(instance.worker.managementMode, "controllerManaged");
    assert.equal(instance.mcpPath, "/demo-local/mcp");
    assert.deepEqual(instance.modelExtensions, ["instance"]);
});

test("controller-managed terminals use the instance Worker RPC surface", async () => {
    const calls: string[] = [];
    const worker = {
        async openTerminal() {
            calls.push("terminal.open");
            return {
                cols: 80,
                createdAtMs: 1,
                generation: 1,
                latestSeq: 0,
                rows: 24,
                state: "running",
                terminalId: "worker-terminal",
                version: 1,
            };
        },
        async attachTerminal() {
            calls.push("terminal.attach");
            return {
                replay: [],
                session: {
                    cols: 80,
                    createdAtMs: 1,
                    generation: 1,
                    latestSeq: 0,
                    rows: 24,
                    state: "running",
                    terminalId: "worker-terminal",
                    version: 1,
                },
            };
        },
        onTerminalNotification() {
            return () => undefined;
        },
        onTransportConnected() {
            return () => undefined;
        },
        onTransportDisconnected() {
            return () => undefined;
        },
        snapshot() {
            return {
                connectionState: "disconnected",
                daemonState: "stopped",
                lastSeq: 0,
                name: "demo-local",
                ready: false,
                status: "stopped",
            };
        },
    };
    const opened = await createTerminalRuntime(worker as unknown as WorkerInstance).api.open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    ("process" in opened ? opened.process : opened).dispose?.();

    assert.deepEqual(calls, ["terminal.open", "terminal.attach"]);
});
