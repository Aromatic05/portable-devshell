import assert from "node:assert/strict";
import test from "node:test";

import { Endpoint, asInstanceName } from "@portable-devshell/shared";

import type { AuditApi } from "../../../src/audit/Api.ts";
import { createToolCallExecutionRuntime } from "../../../src/toolcall/index.ts";

function createRuntime(options: {
    released: string[];
    releaseWorkspace?: (workspace: string) => Promise<void>;
}) {
    const audit = {
        logs: {
            append: async () => {
                throw new Error("unused");
            },
            read: async () => [],
        },
        toolCalls: {
            append: async () => undefined,
            hasCall: () => false,
            readFailureSummary: () => ({ count: 0 }),
            readQuery: () => [],
        },
    } as unknown as AuditApi;
    return createToolCallExecutionRuntime({
        appendEvent: async () => undefined,
        assertReady: () => undefined,
        audit,
        endpoint: new Endpoint(),
        instanceName: asInstanceName("alpha"),
        prepareWorkspace: async (workspace) => ({
            projectMemoryAgentFile: `${workspace}/AGENTS.md`,
            projectMemoryDirectory: `${workspace}/var/agent-work`,
            temporaryDirectory: "/tmp/alpha",
            workspace,
        }),
        readTools: async () => [],
        releaseWorkspace:
            options.releaseWorkspace ??
            (async (workspace) => {
                options.released.push(workspace);
            }),
    });
}

test("tool execution sessions release a workspace after the final connection", async () => {
    const released: string[] = [];
    const runtime = createRuntime({ released });

    await runtime.openSession("/workspace", "connection-a");
    await runtime.openSession("/workspace", "connection-b");
    await runtime.releaseSession("connection-a");
    assert.deepEqual(released, []);

    await runtime.releaseSession("connection-b");
    assert.deepEqual(released, ["/workspace"]);
    await runtime.close();
});

test("tool execution close attempts every session cleanup", async () => {
    const released: string[] = [];
    const runtime = createRuntime({
        released,
        releaseWorkspace: async (workspace) => {
            released.push(workspace);
            if (workspace === "/broken") throw new Error("broken cleanup");
        },
    });

    await runtime.openSession("/broken", "connection-a");
    await runtime.openSession("/healthy", "connection-b");
    await assert.rejects(runtime.close(), /broken cleanup/);
    assert.deepEqual(released, ["/broken", "/healthy"]);
});
