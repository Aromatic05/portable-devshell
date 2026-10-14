import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ExtensionContext } from "@portable-devshell/extension";

import { activate, deactivate } from "../../src/index.ts";

test("Comment Extension declares stable ToolCall hook priorities", () => {
    const manifest = JSON.parse(
        readFileSync(
            new URL("../../src/devshell-extension.json", import.meta.url),
            "utf8",
        ),
    ) as {
        extensions?: Record<string, Array<{ hook?: string; id?: string }>>;
    };

    assert.deepEqual(manifest.extensions?.["toolcall.review"], [
        { hook: "500-toolcall-gate", id: "toolcall-gate" },
    ]);
    assert.deepEqual(manifest.extensions?.["toolcall.rewrite"], [
        { hook: "500-todo-access", id: "todo-access" },
        { hook: "501-todo-invalid", id: "todo-invalid" },
        { hook: "502-tool-advice", id: "tool-advice" },
        { hook: "510-comment-delivery", id: "comment-delivery" },
        { hook: "520-mailing-trigger", id: "mailing-trigger" },
    ]);
});

test("Comment Extension activates from observe and event-publish capabilities without a Comment host interface", async (t) => {
    const registrations: Array<{
        id: string;
        pointId: string;
        binding: unknown;
    }> = [];
    let lists = 0;
    const context = {
        capabilities: {
            database: {
                async open() {
                    throw new Error("unused database");
                },
            },
            instanceObserve: {
                async list() {
                    lists += 1;
                    return [];
                },
                async readLogs() {
                    return [];
                },
                async refresh() {
                    throw new Error("unused");
                },
                async snapshot() {
                    throw new Error("unused");
                },
                async watchEvents() {},
            },
            instanceEventPublish: {
                async appendEvent() {},
            },
            contextObserve: {
                async list() { return []; },
            },
            workerExecute: {
                async openSession() { throw new Error("unused Worker"); },
            },
        },
        paths: {
            codeDirectory: "/comment/code",
            dataDirectory: "/comment/data",
            runtimeDirectory: "/comment/runtime",
            stateDirectory: "/tmp/comment-control/extensions/state/comment",
        },
        logger: { error() {}, warn() {}, info() {}, debug() {} },
        register(point: { id: string }, id: string, binding: unknown) {
            registrations.push({ binding, id, pointId: point.id });
        },
    } as unknown as ExtensionContext;
    t.after(async () => await deactivate());

    await activate(context);
    assert.equal(registrations.length, 15);
    assert.deepEqual(
        registrations.map(({ id, pointId }) => ({ id, pointId })),
        [
            { id: "toolcall-gate", pointId: "toolcall.review" },
            { id: "todo-access", pointId: "toolcall.rewrite" },
            { id: "comment-delivery", pointId: "toolcall.rewrite" },
            { id: "tool-advice", pointId: "toolcall.rewrite" },
            { id: "todo-invalid", pointId: "toolcall.rewrite" },
            { id: "mailing-trigger", pointId: "toolcall.rewrite" },
            { id: "memory", pointId: "cli.model-commands" },
            { id: "memory", pointId: "cli.native-commands" },
            { id: "message-subscribe", pointId: "control.streams" },
            { id: "context-message-list", pointId: "control.routes" },
            { id: "context-message-queue", pointId: "control.routes" },
            { id: "message-list", pointId: "control.routes" },
            { id: "message-preferences", pointId: "control.routes" },
            {
                id: "message-update-preferences",
                pointId: "control.routes",
            },
            { id: "todo_report", pointId: "mcp.tools" },
        ],
    );
    assert.equal(typeof registrations[0]?.binding, "function");

    const binding = registrations[0]!.binding as (
        input: unknown,
        context: {
            signal: AbortSignal;
            requestInterface(operation: string): Promise<unknown>;
        },
    ) => Promise<unknown>;
    assert.deepEqual(
        await binding(
            {
                callId: "call-1",
                direction: "inbound",
                value: {
                    context: {
                        ctxId: "ctx-1",
                        instance: "demo",
                        source: "cli",
                    },
                    kind: "call",
                    payload: {},
                    toolName: "bash_run",
                },
            },
            {
                signal: new AbortController().signal,
                async requestInterface() {
                    throw new Error(
                        "Comment review must not request a host interface",
                    );
                },
            },
        ),
        { decision: "continue" },
    );
    assert.equal(lists, 2);
});
