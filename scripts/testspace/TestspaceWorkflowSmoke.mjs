import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

/** A real MCP client drives Instance Todo, ToolCall, MCPApp Action and Reentry. */
export async function runTestspaceWorkflowSmoke({ endpoint, instance, runtimeDirectory, workspace }) {
    const client = new Client({ name: "testspace-workflow-smoke", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    let taskId;
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const environment = await call(client, "environ_info", { workspace });
        const ctxId = environment.ctxId;
        assert.ok(typeof ctxId === "string" && ctxId.length > 0);
        const auth = environment.__meta;
        assert.equal(typeof auth?.liveBaseUrl, "string");
        assert.equal(typeof auth?.token, "string");

        const created = await call(client, "todo_write", {
            ctxId,
            revision: 0,
            title: `testspace-workflow-${randomUUID()}`,
            todos: [{ id: "verify", content: "Verify authorized tool execution", status: "in_progress" }],
        });
        taskId = created.taskId;
        assert.ok(typeof taskId === "string" && taskId.length > 0);
        assert.ok(Number.isSafeInteger(created.revision));

        const tool = await call(client, "bash_run", {
            command: "printf 'testspace workflow tool executed\\n'",
            ctxId,
            timeoutMs: 10_000,
        });
        assert.equal(tool.exitCode, 0);
        assert.match(tool.stdout, /testspace workflow tool executed/u);

        const current = () => withTestspaceControlConnection(runtimeDirectory, async (shared, connection) =>
            await shared.createTaskTransport(connection, instance).getTodo({ taskId }));
        const before = await current();
        assert.equal(before.todo.taskId, taskId);

        const pauseId = randomUUID();
        const pause = { ctxId, itemId: taskId, actionId: "task-pause",
            expectedRevision: before.todo.revision, requestId: pauseId };
        assert.equal((await call(client, "mcpapp_action", pause)).status, "applied");
        const paused = await current();
        assert.ok(typeof paused.todo.pausedAt === "string");
        assert.ok(paused.todo.revision > before.todo.revision);
        // Replaying one request must not increment revision or run ToolCall twice.
        assert.equal((await call(client, "mcpapp_action", pause)).status, "applied");
        assert.equal((await current()).todo.revision, paused.todo.revision);

        const resume = { ctxId, itemId: taskId, actionId: "task-resume",
            expectedRevision: paused.todo.revision, requestId: randomUUID() };
        assert.equal((await call(client, "mcpapp_action", resume)).status, "applied");
        const resumed = await current();
        assert.equal(resumed.todo.pausedAt, undefined);
        assert.ok(resumed.todo.revision > paused.todo.revision);

        const snapshotUrl = new URL(`${auth.liveBaseUrl}/snapshot`);
        snapshotUrl.searchParams.set("ctxId", ctxId);
        assert.equal((await fetch(snapshotUrl)).status, 401);
        const response = await fetch(snapshotUrl, { headers: { authorization: `Bearer ${auth.token}` } });
        assert.equal(response.status, 200);
        const snapshot = await response.json();
        assert.equal(snapshot.ctxId, ctxId);
        assert.equal(snapshot.instance, instance);
        const directive = snapshot.reentry?.directives?.find((item) =>
            item.intent === "task-resume" && item.sourceId === taskId);
        assert.ok(directive?.id, "Resume must produce a durable server-owned recovery directive.");
        const recovery = { ctxId, claimId: `claim-${randomUUID()}`,
            directiveId: directive.id, intent: "task-resume", sourceId: taskId };
        const claim = await call(client, "mcpapp_reentry", { ...recovery, action: "claim" });
        assert.equal(claim.claimed, true);
        assert.match(claim.delivery?.message, /workspace Task/u);
        assert.ok(claim.delivery?.modelContext, "Server must supply fresh model Context to the Host.");
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "validate" })).valid, true);
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "attempt" })).attempted, true);
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "attempt" })).duplicate, true);
        // The Testspace client has no ChatGPT Host. Report simulated rejection
        // rather than claiming a message was actually delivered to an Agent.
        await call(client, "mcpapp_reentry", { ...recovery, action: "report", outcome: "rejected" });
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "claim" })).claimed, false);

        const toolCalls = await withTestspaceControlConnection(runtimeDirectory, async (shared, connection) =>
            await shared.createToolTransport(connection, instance).listCalls({ ctxId, limit: 100 }));
        for (const name of ["todo_write", "bash_run", "mcpapp_action", "mcpapp_reentry"])
            assert.ok(toolCalls.some((entry) => entry.toolName === name && entry.status === "completed"),
                `Missing completed audited ToolCall: ${name}`);
        return {
            instance,
            ctxId,
            taskId,
            toolCalls: toolCalls.length,
            paused: true,
            resumed: true,
            replayFenced: true,
            reentryReceiptSettled: true,
            hostDelivery: "simulated-rejected",
        };
    } finally {
        if (taskId) await withTestspaceControlConnection(runtimeDirectory, async (shared, endpointConnection) =>
            await shared.createTaskTransport(endpointConnection, instance).deleteTodo(taskId));
        await client.close().catch(() => undefined);
    }
}

async function call(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError)
        throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
    const value = result.structuredContent;
    assert.ok(value && typeof value === "object", `${name} must return structuredContent`);
    return {
        ...value,
        ...(name === "environ_info" ? { __meta: result._meta?.["portable-devshell/mcpapp"] } : {}),
    };
}
