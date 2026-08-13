import assert from "node:assert/strict";
import test from "node:test";

import type { McpContextRecord, PrefixRouteContext } from "@portable-devshell/shared";

import { createContextRouteModule, type ContextAdminPort } from "../../src/control/mcp/ContextRouteModule.ts";

function record(ctxId: string): McpContextRecord {
    return {
        createdAt: "2026-08-10T00:00:00.000Z",
        ctxId,
        expiresAt: "2026-08-11T00:00:00.000Z",
        instance: "demo-local",
        lastAccessedAt: "2026-08-10T00:00:00.000Z",
        principal: "local",
        status: "active",
        workspace: "/workspace",
    };
}

test("context routes resolve the current admin port for every request", async () => {
    let current = "first";
    const port = (): ContextAdminPort => ({
        async disable(ctxId) { return record(`${current}:disable:${ctxId}`); },
        async list() { return [record(`${current}:list`)]; },
        async renew(ctxId) { return record(`${current}:renew:${ctxId}`); },
        async validateForInstance(ctxId, instance) { return record(`${current}:validate:${instance}:${ctxId}`); },
    });
    const module = createContextRouteModule(port);
    const list = module.operations.find((operation) => operation.name === "list");
    if (list === undefined) throw new Error("context.list operation is missing");
    const context = { connectionId: "conn", peer: "cli", requestId: "req" } as PrefixRouteContext;

    const first = await list.handle({ id: "1", name: "list" }, context);
    current = "second";
    const second = await list.handle({ id: "2", name: "list" }, context);

    assert.deepEqual(first, [record("first:list")]);
    assert.deepEqual(second, [record("second:list")]);
});
