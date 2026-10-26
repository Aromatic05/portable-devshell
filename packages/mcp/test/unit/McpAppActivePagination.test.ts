import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { asInstanceName, Endpoint, Rpc, type GoalSnapshot, type ToolCallQuery } from "@portable-devshell/shared";
import { AuditDatabase } from "../../../core/src/audit/database/index.ts";
import { ToolCallHistory } from "../../../core/src/toolcall/execution/record/History.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { createMcpAppViewModel } from "../../src/mcpapp/ViewModel.ts";

test("a real active-to-persisted page boundary cannot mark an older running Agent ready", async (t) => {
    const directory = await createTestTempDirectory("mcpapp-active-pagination");
    const database = new AuditDatabase(join(directory, "audit.sqlite3"), {
        maxBytes: 16 * 1024 * 1024, retentionDays: 30,
    });
    const history = new ToolCallHistory(asInstanceName("test"), database.toolCallStore({
        timestamp: (record) => record.completedAt ?? record.startedAt,
    }));
    const endpoint = new Endpoint({ host: "mcpapp-active-pagination" });
    endpoint.connect = async (host, port) => endpoint.bind(`client-${port}`).connect(host, port);
    const at = new Date().toISOString();
    const context = { ctxId: "ctx-a", source: "mcp" as const, workspace: "/test" };
    await history.started("agent", "bash_run", "{}", context, at);
    for (let i = 0; i < 64; i++) await history.started(`ui-${i}`, "mcpapp_open", "{}", context, at);
    const goal: GoalSnapshot = {
        goalId: "goal", objective: "Finish work", status: "active", revision: 1,
        continuationDue: true, continuationDueAt: at, continuationPending: false,
        continuationUncertain: false, continuationCount: 0, autoContinueExhausted: false,
        createdAt: at, updatedAt: at, lastAgentActivityAt: at, lastProgressAt: at,
    };
    const task = new Rpc(endpoint.bind("task", "test"), {
        getGoal: () => ({ goal, lastSeq: 12 }), getWaits: () => ({ waits: [], lastSeq: 12 }),
    });
    const approval = new Rpc(endpoint.bind("approval", "test"), {
        snapshot: () => ({ approvals: [], lastSeq: 12 }),
    });
    let boundary: string | undefined;
    const queries: ToolCallQuery[] = [];
    const tool = new Rpc(endpoint.bind("tool", "test"), {
        listCalls: async (request) => {
            const query = request as ToolCallQuery;
            queries.push(query);
            const page = await history.read(query);
            if (queries.length === 1) {
                assert.equal(page.length, 64);
                assert.ok(page.every((call) => call.toolName === "mcpapp_open"));
                boundary = page[0]!.callId;
                await history.completed(boundary, at);
            }
            return page;
        },
    });
    t.after(async () => {
        tool.close(); approval.close(); task.close(); endpoint.close();
        await database.close(); await rm(directory, { recursive: true, force: true });
    });
    const view = createMcpAppViewModel(endpoint);
    const raced = await view.snapshot("test", "ctx-a");
    assert.equal(raced.agentBusy, true);
    assert.equal(raced.reentry.schedule, undefined);
    assert.equal(queries.length, 1, "No cursor into the mutable active set is used");
    assert.equal((await history.read({ callIds: [boundary!] }))[0]?.status, "completed");
    assert.equal((await view.snapshot("test", "ctx-a")).agentBusy, true);
    await history.completed("agent", at);
    const ready = await view.snapshot("test", "ctx-a");
    assert.equal(ready.agentBusy, false, "A fresh unfilled page containing only UI calls proves ready");
    assert.equal(ready.reentry.schedule?.sourceId, goal.goalId);
});
