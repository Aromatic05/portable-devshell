import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue } from "@portable-devshell/shared";
import { McpAppActionStore } from "../../../src/mcpapp/ActionStore.ts";
import { McpAppCall } from "../../../src/mcpapp/Call.ts";
import type { McpEndpointDispatch } from "../../../src/protocol/dispatch/Dispatch.ts";

const ctxId = "ctx-app-rewrite";
const request = { principal: "local" };
const input = (requestId: string): JsonValue => ({
    ctxId, itemId: "goal-original", actionId: "goal-resume", requestId,
});
function receiptKey(requestId: string): string {
    return createHash("sha256").update(JSON.stringify(["demo", ctxId, requestId])).digest("hex");
}

function harness(mode: "rewrite-action" | "rewrite-tool" | "rewrite-instance" | "synthetic" | "original") {
    const actions = new McpAppActionStore();
    const raw = mode === "original"
        ? { status: "applied", actionId: "goal-resume", itemId: "goal-original" }
        : { status: "applied", actionId: "goal-pause", itemId: "goal-executed" };
    const dispatch = {
        async callTool(_tool: string, _input: JsonValue, _request: unknown, _signal?: AbortSignal,
            onExecuted?: (callId: string, value: unknown, result: JsonValue) => void) {
            if (mode !== "synthetic") onExecuted?.("instance-call-id", {
                kind: "call",
                toolName: mode === "rewrite-tool" ? "bash_run" : "mcpapp_action",
                context: { ctxId, instance: mode === "rewrite-instance" ? "different" : "demo", source: "mcp" },
                payload: raw,
            }, raw);
            return raw;
        },
    } as unknown as Pick<McpEndpointDispatch, "callTool">;
    const call = new McpAppCall({
        actions, instance: "demo", dispatch,
        context: { async resolve() {
            return { ctxId, status: "active", environments: [{ instance: "demo", workspace: "/repo" }] } as never;
        } },
    });
    return { actions, call };
}

test("Action Receipt records the rewritten executed action, not the original reentry intent", async () => {
    const { actions, call } = harness("rewrite-action");
    const id = "action-rewrite-12345678";
    assert.deepEqual(await call.call("mcpapp_action", input(id), request), {
        status: "applied", actionId: "goal-pause", itemId: "goal-executed",
    });
    const receipt = await actions.get(receiptKey(id));
    assert.equal(receipt?.resolved.operation, "goal-resume");
    assert.deepEqual(receipt?.execution, {
        callId: "instance-call-id", instance: "demo", toolName: "mcpapp_action",
        actionId: "goal-pause", itemId: "goal-executed",
    });
    assert.equal(receipt?.status, "applied");
    assert.equal(receipt?.effect, undefined);
    assert.deepEqual(await call.call("mcpapp_action", input(id), request), {
        status: "applied", actionId: "goal-pause", itemId: "goal-executed",
    });
});

test("synthetic successes and rewrites to unrelated tools or instances cannot mint App Reentry", async () => {
    for (const mode of ["synthetic", "rewrite-tool", "rewrite-instance"] as const) {
        const { actions, call } = harness(mode);
        const id = `action-${mode}-12345678`;
        await call.call("mcpapp_action", input(id), request);
        const receipt = await actions.get(receiptKey(id));
        assert.equal(receipt?.status, "conflicted", mode);
        assert.equal(receipt?.effect, undefined, mode);
        assert.deepEqual(await actions.pendingDirectives(ctxId, "demo"), [], mode);
    }
});

test("verified successful Goal resume still creates a directive tied to its executed ToolCall", async () => {
    const { actions, call } = harness("original");
    const id = "action-original-12345678";
    await call.call("mcpapp_action", input(id), request);
    const receipt = await actions.get(receiptKey(id));
    assert.equal(receipt?.status, "applied");
    assert.equal(receipt?.execution?.callId, "instance-call-id");
    assert.deepEqual(receipt?.effect, {
        kind: "reentry", intent: "goal-resume", sourceId: "goal-original", id: receiptKey(id),
    });
});
