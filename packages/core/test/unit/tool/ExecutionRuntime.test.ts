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

test("failed final Workspace release keeps its session owner and retries without releasing other owners", async () => {
    const released: string[] = [];
    const attempts: string[] = [];
    let release: (workspace: string) => Promise<void> = async (_workspace) => { throw new Error("temporary release failure"); };
    const runtime = createRuntime({ released, releaseWorkspace: async (workspace) => {
        attempts.push(workspace);
        await release(workspace);
        released.push(workspace);
    } });
    await runtime.openSession("/workspace", "a");
    await runtime.openSession("/workspace", "b");
    await runtime.releaseSession("a");
    await assert.rejects(runtime.releaseSession("b"), /temporary release failure/u);
    assert.deepEqual(released, []);
    release = async () => {};
    await runtime.releaseSession("b");
    await runtime.releaseSession("b");
    await runtime.close();
    assert.deepEqual(attempts, ["/workspace", "/workspace"]);
    assert.deepEqual(released, ["/workspace"]);
});

test("runtime close retries retained release debt without repeating successful Workspace releases", async () => {
    const released: string[] = [];
    let release: (workspace: string) => Promise<void> = async (_workspace) => { throw new Error("close release debt"); };
    const runtime = createRuntime({ released, releaseWorkspace: async (workspace) => {
        await release(workspace);
        released.push(workspace);
    } });
    await runtime.openSession("/workspace", "session");
    await assert.rejects(runtime.close(), /close release debt/u);
    assert.deepEqual(released, []);
    release = async () => {};
    await runtime.close();
    await runtime.close();
    assert.deepEqual(released, ["/workspace"]);
});

test("concurrent final releases serialize Workspace ownership and retain only the failed owner", async () => {
    const released: string[] = [];
    let attempts = 0;
    let release: () => Promise<void> = async () => { attempts++; throw new Error("last owner debt"); };
    const runtime = createRuntime({ released, releaseWorkspace: async (workspace) => {
        await release(); released.push(workspace);
    } });
    await runtime.openSession("/shared", "a");
    await runtime.openSession("/shared", "b");
    const first = runtime.releaseSession("a");
    const second = assert.rejects(runtime.releaseSession("b"), /last owner debt/u);
    await Promise.all([first, second]);
    assert.equal(attempts, 1);
    release = async () => { attempts++; };
    await runtime.close();
    assert.equal(attempts, 2);
    assert.deepEqual(released, ["/shared"]);
});
