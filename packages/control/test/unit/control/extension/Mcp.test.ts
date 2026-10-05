import assert from "node:assert/strict";
import test from "node:test";

import {
    presentToolCallResult,
    type ToolCallHooks,
} from "@portable-devshell/core/toolcall";
import { mcpTools } from "@portable-devshell/mcp/tool";
import type { InstanceName } from "@portable-devshell/shared";

import { McpExtensionService } from "../../../../src/extension/api/point/mcp/Service.ts";

test("MCP Extension tools publish definitions and execute through ToolCall hooks", async () => {
    let releases = 0;
    let listener: (() => void) | undefined;
    let declarations = [
        {
            declaration: {
                activity: "observation",
                description: "Send progress.",
                destructiveHint: false,
                id: "todo_report",
                idempotentHint: false,
                inputSchema: {
                    properties: {
                        message: {
                            description: "Progress message.",
                            type: "string",
                        },
                    },
                    type: "object",
                },
                openWorldHint: false,
                outputSchema: {
                    properties: { reported: { type: "boolean" } },
                    type: "object",
                },
                readOnlyHint: false,
                title: "Message user",
            },
            extensionId: "comment",
            id: "todo_report",
        },
    ];
    const service = new McpExtensionService({
        listDeclarations(pointId: string) {
            assert.equal(pointId, "mcp.tools");
            return declarations as never;
        },
        onChange(next: () => void) {
            listener = next;
            return () => {
                listener = undefined;
            };
        },
        async acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "mcp.tools");
            assert.equal(id, "todo_report");
            return {
                extensionId: "comment",
                lease: {
                    release() {
                        releases += 1;
                    },
                },
                registration: {
                    binding: async (
                        input: unknown,
                        context: { ctxId?: string },
                    ) => {
                        assert.deepEqual(input, { message: "done" });
                        assert.equal(context.ctxId, "ctx-one");
                        return {
                            content: [{ text: "done", type: "text" }],
                            structuredContent: { reported: true },
                        };
                    },
                },
            } as never;
        },
    } as never);
    const executes = new Map<
        string,
        Parameters<ToolCallHooks["registerExecute"]>[1]
    >();
    const hooks = {
        registerContributor: () => () => undefined,
        registerExecute: (
            name: string,
            execute: Parameters<ToolCallHooks["registerExecute"]>[1],
        ) => {
            executes.set(name, execute);
            return () => executes.delete(name);
        },
        registerReview: () => () => undefined,
        registerToolName: () => () => undefined,
    } as ToolCallHooks;

    const uninstall = service.install(hooks);
    try {
        const tool = mcpTools.get("remote-server", "todo_report")?.definition;
        assert.equal(tool?.name, "todo_report");
        assert.equal(tool?.description, "Send progress.");
        assert.deepEqual(tool?._meta, {
            devshell: {
                extensionId: "comment",
                mcp: {
                    activity: "observation",
                    annotations: {
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: false,
                        readOnlyHint: false,
                    },
                    extensionTool: true,
                    preserveInputDescriptions: true,
                    title: "Message user",
                },
            },
        });
        const execute = executes.get("todo_report");
        assert.ok(execute);
        const result = await execute(
            "call-one",
            { message: "done" },
            {
                context: {
                    ctxId: "ctx-one",
                    instance: "remote-server" as InstanceName,
                    source: "mcp",
                },
                kind: "call",
                payload: { message: "done" },
                toolName: "todo_report",
            },
        );
        const presented = presentToolCallResult(
            { reported: true },
            { content: [{ text: "done", type: "text" }] },
        );
        assert.deepEqual(result, presented);
        assert.equal(releases, 1);

        declarations = [];
        listener?.();
        assert.equal(mcpTools.get("remote-server", "todo_report"), undefined);
        assert.equal(executes.has("todo_report"), false);
    } finally {
        uninstall();
    }
});

test("MCP Context terminal delegates to Extension Context environment retirement", async () => {
    const calls: Array<{
        ctxId: string;
        instance: string;
        reason: "disabled" | "expired";
    }> = [];
    const service = new McpExtensionService({
        listDeclarations() {
            return [];
        },
        async acquireRegistration() {
            throw new Error("unexpected registration lookup");
        },
        async contextEnvironmentRetired(input: {
            ctxId: string;
            instance: string;
            reason: "disabled" | "expired";
        }) {
            calls.push(input);
        },
    } as never);

    await service.contextTerminated("remote-server", "ctx-one", "expired");
    assert.deepEqual(calls, [
        {
            ctxId: "ctx-one",
            instance: "remote-server",
            reason: "expired",
        },
    ]);
});
