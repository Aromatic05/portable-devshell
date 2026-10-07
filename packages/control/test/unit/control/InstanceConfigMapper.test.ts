import assert from "node:assert/strict";
import test from "node:test";
import { createInstance } from "@portable-devshell/core";
import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";

import type { WorkerTerminalPort } from "../../../../core/src/terminal/Api.ts";
import { createTerminalRuntime } from "../../../../core/src/terminal/index.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("instance composition keeps configured security mode and starts with no admitted worker", async (t) => {
    const home = await createTestTempDirectory("instance-config-mapper");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
        const instance = createInstance(normalizeConfigInstanceDraft({
            enabled: true, name: "demo-local", provider: "local", security: { mode: "workspace" },
            env: { DEMO: "1" }, extensions: { model: ["instance"] },
        }));
        t.after(async () => { await instance.close(); });
        assert.equal(instance.supervision.snapshot().effectiveSecurityMode, "workspace");
        assert.equal(instance.supervision.snapshot().ready, false);
        assert.equal(instance.supervision.managementMode, "controllerManaged");
        assert.equal(instance.config.mcpPath, "/demo-local/mcp");
        assert.deepEqual(instance.config.modelExtensions, ["instance"]);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
    }
});

test("controller-managed terminals use the instance Worker RPC surface", async () => {
    const calls: string[] = [];
    const descriptor = {
        cols: 80,
        createdAtMs: 1,
        generation: 1,
        latestSeq: 0,
        rows: 24,
        state: "running" as const,
        terminalId: "worker-terminal",
        version: 1,
    };
    const worker: WorkerTerminalPort = {
        async open() {
            calls.push("terminal.open");
            return descriptor;
        },
        async attach() {
            calls.push("terminal.attach");
            return {
                replay: [],
                session: descriptor,
            };
        },
        async write() {
            throw new Error("Unexpected terminal write.");
        },
        async resize() {
            throw new Error("Unexpected terminal resize.");
        },
        async kill() {
            throw new Error("Unexpected terminal kill.");
        },
        async list() {
            return [];
        },
        onNotification() {
            return () => undefined;
        },
        onConnected() {
            return () => undefined;
        },
        onDisconnected() {
            return () => undefined;
        },
    };
    const opened = await createTerminalRuntime(worker).api.open({
        cols: 80,
        rows: 24,
        workspace: "/workspace",
    });
    ("process" in opened ? opened.process : opened).dispose?.();

    assert.deepEqual(calls, ["terminal.open", "terminal.attach"]);
});
