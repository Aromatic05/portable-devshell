import assert from "node:assert/strict";
import test from "node:test";

import type {
    McpContextRecord,
    ControlPortContext,
} from "@portable-devshell/shared";

import {
    createContextRouteModule,
    type ContextAdminPort,
} from "../../../../src/context/Route.ts";
import { ContextChangeHub } from "../../../../src/context/Registry/Change.ts";

function record(ctxId: string): McpContextRecord {
    return {
        createdAt: "2026-08-10T00:00:00.000Z",
        ctxId,
        environments: [{ instance: "demo-local", workspace: "/workspace" }],
        expiresAt: "2026-08-11T00:00:00.000Z",
        lastAccessedAt: "2026-08-10T00:00:00.000Z",
        principal: "local",
        status: "active",
    };
}

test("context routes resolve the current admin port for every request", async () => {
    let current = "first";
    const port = (): ContextAdminPort => ({
        registry: {
            changes: new ContextChangeHub(),
            async snapshot() {
                return { contexts: [record(`${current}:snapshot`)], revision: 0 };
            },
            async referenceInstance() {
                return { current: true };
            },
            async list() {
                return [record(`${current}:list`)];
            },
            async validateForInstance(ctxId, instance) {
                return record(`${current}:validate:${instance}:${ctxId}`);
            },
        },
        async disable(ctxId) {
            return record(`${current}:disable:${ctxId}`);
        },
        async renew(ctxId) {
            return record(`${current}:renew:${ctxId}`);
        },
    });
    const module = createContextRouteModule(port);
    const list = module.operations.find(
        (operation) => operation.name === "list",
    );
    if (list === undefined)
        throw new Error("context.list operation is missing");
    const context = {
        connectionId: "conn",
        host: "@control",
        peer: "cli",
        requestId: "req",
        signal: new AbortController().signal,
        afterReply() {},
    } as ControlPortContext;

    const first = await list.handle({ id: "1", name: "list" }, context);
    current = "second";
    const second = await list.handle({ id: "2", name: "list" }, context);

    assert.deepEqual(first, [record("first:list")]);
    assert.deepEqual(second, [record("second:list")]);
});
