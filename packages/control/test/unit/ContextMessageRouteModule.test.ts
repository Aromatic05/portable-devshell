import assert from "node:assert/strict";
import test from "node:test";

import type { McpContextRecord, PrefixRouteContext } from "@portable-devshell/shared";

import type { ContextAdminPort } from "../../src/control/mcp/ContextRouteModule.ts";
import { createContextMessageRouteModule } from "../../src/instance/context/ContextMessageRouteModule.ts";

function contextRecord(ctxId: string, instance: string): McpContextRecord {
    return {
        createdAt: "2026-08-13T00:00:00.000Z",
        ctxId,
        environments: [{ instance, workspace: "/workspace" }],
        expiresAt: "2026-08-13T01:00:00.000Z",
        instance,
        lastAccessedAt: "2026-08-13T00:00:00.000Z",
        principal: "client",
        status: "active",
        workspace: "/workspace",
    };
}

test("contextMessage.queue validates the Context against the destination instance before persisting", async () => {
    const calls: string[] = [];
    const admin: ContextAdminPort = {
        async disable(ctxId) { return contextRecord(ctxId, "alpha"); },
        async list() { return []; },
        async renew(ctxId) { return contextRecord(ctxId, "alpha"); },
        async validateForInstance(ctxId, instance) {
            calls.push(`validate:${instance}:${ctxId}`);
            if (ctxId === "ctx-disabled") {
                const error = new Error("disabled") as Error & { code: string };
                error.code = "mcp.contextDisabled";
                throw error;
            }
            return contextRecord(ctxId, instance);
        },
    };
    const service = {
        async list() { return []; },
        async queue(input: { ctxId: string; text: string }) {
            calls.push(`queue:${input.ctxId}`);
            return {
                createdAt: "2026-08-13T00:00:00.000Z",
                ctxId: input.ctxId,
                id: "message-1",
                instance: "alpha",
                status: "sent" as const,
                text: input.text,
            };
        },
    };
    const module = createContextMessageRouteModule(service, "alpha", () => admin);
    const queue = module.operations.find((operation) => operation.name === "queue");
    if (queue === undefined) throw new Error("contextMessage.queue operation is missing");
    const routeContext = { connectionId: "conn", peer: "cli", requestId: "req" } as PrefixRouteContext;

    await assert.rejects(
        async () => await queue.handle(
            { id: "1", name: "queue", payload: { ctxId: "ctx-disabled", text: "ignored" } },
            routeContext,
        ),
        (error: unknown) => (error as { code?: string }).code === "mcp.contextDisabled",
    );
    assert.deepEqual(calls, ["validate:alpha:ctx-disabled"]);

    const result = await queue.handle(
        { id: "2", name: "queue", payload: { ctxId: "ctx-active", text: "continue" } },
        routeContext,
    );
    assert.equal((result as { status?: string }).status, "sent");
    assert.deepEqual(calls, [
        "validate:alpha:ctx-disabled",
        "validate:alpha:ctx-active",
        "queue:ctx-active",
    ]);
});
