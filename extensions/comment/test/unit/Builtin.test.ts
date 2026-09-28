import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@portable-devshell/extension";

import { activate, deactivate } from "../../src/index.ts";

test("Comment Extension activates its review from instanceRuntime without a Comment host interface", async (t) => {
    const registrations: Array<{ id: string; pointId: string; binding: unknown }> = [];
    let lists = 0;
    const context = {
        capabilities: {
            instanceRuntime: {
                async appendEvent() {},
                async list() {
                    lists += 1;
                    return [];
                },
                async readToolCalls() {
                    return [];
                },
            },
        },
        paths: {
            codeDirectory: "/comment/code",
            dataDirectory: "/comment/data",
            runtimeDirectory: "/comment/runtime",
            stateDirectory: "/tmp/comment-control/extensions/state/comment",
        },
        register(point: { id: string }, id: string, binding: unknown) {
            registrations.push({ binding, id, pointId: point.id });
        },
    } as unknown as ExtensionContext;
    t.after(async () => await deactivate());

    await activate(context);
    assert.equal(registrations.length, 8);
    assert.deepEqual(
        registrations.map(({ id, pointId }) => ({ id, pointId })),
        [
            { id: "comment", pointId: "toolcall.review" },
            { id: "context-message-list", pointId: "control.routes" },
            { id: "context-message-queue", pointId: "control.routes" },
            { id: "conversation-list", pointId: "control.routes" },
            { id: "conversation-preferences", pointId: "control.routes" },
            {
                id: "conversation-update-preferences",
                pointId: "control.routes",
            },
            { id: "todo_report", pointId: "mcp.tools" },
            { id: "comment", pointId: "mcp.context-terminal" },
        ],
    );
    assert.equal(typeof registrations[0]?.binding, "function");

    const binding = registrations[0]!.binding as (
        input: unknown,
        context: { requestInterface(operation: string): Promise<unknown> },
    ) => Promise<unknown>;
    assert.deepEqual(
        await binding(
            {
                callId: "call-1",
                context: {
                    ctxId: "ctx-1",
                    instance: "demo",
                    source: "cli",
                },
                direction: "inbound",
                kind: "call",
                payload: {},
                signal: new AbortController().signal,
                toolName: "bash_run",
            },
            {
                async requestInterface() {
                    throw new Error("Comment review must not request a host interface");
                },
            },
        ),
        { decision: "accept" },
    );
    assert.equal(lists, 2);
});
