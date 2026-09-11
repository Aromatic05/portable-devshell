import assert from "node:assert/strict";
import test from "node:test";

import type { PrefixRouteContext } from "@portable-devshell/shared";

import { createContextMessageRouteModule } from "../../src/instance/context/ContextMessageRouteModule.ts";

test("contextMessage.queue persists independently of Context lifecycle authority", async () => {
    const calls: string[] = [];
    const service = {
        async list() { return []; },
        async queue(input: { ctxId: string; text: string }) {
            calls.push(`queue:${input.ctxId}:${input.text}`);
            return {
                createdAt: "2026-08-13T00:00:00.000Z",
                ctxId: input.ctxId,
                id: `message-${calls.length}`,
                instance: "alpha",
                status: "sent" as const,
                text: input.text,
            };
        },
    };
    const module = createContextMessageRouteModule(service);
    const queue = module.operations.find((operation) => operation.name === "queue");
    if (queue === undefined) throw new Error("contextMessage.queue operation is missing");
    const routeContext = { connectionId: "conn", peer: "cli", requestId: "req" } as PrefixRouteContext;

    const disabled = await queue.handle(
        { id: "1", name: "queue", payload: { ctxId: "ctx-disabled", text: "still writable" } },
        routeContext,
    );
    const missing = await queue.handle(
        { id: "2", name: "queue", payload: { ctxId: "ctx-history-only", text: "history remains writable" } },
        routeContext,
    );

    assert.equal((disabled as { status?: string }).status, "sent");
    assert.equal((missing as { status?: string }).status, "sent");
    assert.deepEqual(calls, [
        "queue:ctx-disabled:still writable",
        "queue:ctx-history-only:history remains writable",
    ]);
});
