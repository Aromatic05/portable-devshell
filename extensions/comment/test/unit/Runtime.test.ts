import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@portable-devshell/extension";

import { activate } from "../../src/runtime/index.ts";

test("Comment Extension activates one toolcall.review binding without a global capability", async () => {
    const registrations: Array<{ id: string; pointId: string; binding: unknown }> = [];
    const context = {
        capabilities: {},
        register(point: { id: string }, id: string, binding: unknown) {
            registrations.push({ binding, id, pointId: point.id });
        },
    } as unknown as ExtensionContext;

    activate(context);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.pointId, "toolcall.review");
    assert.equal(registrations[0]?.id, "comment");
    assert.equal(typeof registrations[0]?.binding, "function");

    const binding = registrations[0]!.binding as (
        input: unknown,
        context: { requestInterface(operation: string): Promise<unknown> },
    ) => Promise<unknown>;
    assert.deepEqual(
        await binding(
            {
                context: {
                    ctxId: "ctx-1",
                    instance: "demo",
                    source: "mcp",
                },
                direction: "inbound",
                kind: "call",
                payload: {},
                signal: new AbortController().signal,
                toolName: "bash_run",
            },
            {
                async requestInterface(operation) {
                    assert.equal(operation, "comment.reviewToolCall");
                    return { commentId: "stop-1", kind: "stop" };
                },
            },
        ),
        {
            decision: "reject",
            error: {
                code: "control.modelStopped",
                details: { commentId: "stop-1" },
            },
            reason: "Stopped by user. Tool calls are disabled until the user sends #resume.",
        },
    );
});
