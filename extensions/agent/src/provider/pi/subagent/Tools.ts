import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { JsonValue } from "@portable-devshell/shared";

import type { PiExtensionApiLike, PiToolLike } from "../adapt/Bridge.js";
import { renderPiToolCall, renderPiToolResult } from "../render/ToolRenderer.js";
import type { PiSubagentRuntime } from "./Runtime.js";

export const PI_SUBAGENT_TOOL_NAMES = Object.freeze([
    "agent_spawn",
    "agent_poll",
    "agent_interact",
    "agent_manage",
] as const);

export function attachPiSubagentTools(
    pi: PiExtensionApiLike,
    runtime: PiSubagentRuntime,
): void {
    for (const tool of createPiSubagentTools(runtime)) pi.registerTool(tool);
}

export function createPiSubagentTools(runtime: PiSubagentRuntime): PiToolLike[] {
    const spawn = defineTool({
        name: "agent_spawn",
        label: "Spawn Agent",
        description:
            "Spawn an isolated child Agent under /root/main. Use a short semantic name and a focused task. profile selects an optional Agent Profile. fork=false creates a clean context; fork=true is reserved and currently unsupported.",
        parameters: Type.Object({
            name: Type.String({ minLength: 1 }),
            task: Type.String({ minLength: 1 }),
            profile: Type.Optional(Type.String({ minLength: 1 })),
            fork: Type.Optional(Type.Boolean({ default: false })),
        }),
        async execute(_toolCallId, params) {
            return toolResult(
                await runtime.spawn({
                    name: params.name,
                    task: params.task,
                    ...(params.profile === undefined ? {} : { profile: params.profile }),
                    ...(params.fork === undefined ? {} : { fork: params.fork }),
                }),
            );
        },
        renderCall: (args, theme, context) =>
            renderPiToolCall("agent_spawn", args, theme, context),
        renderResult: (result, options, theme, context) =>
            renderPiToolResult("agent_spawn", result, options, theme, context),
    });
    const poll = defineTool({
        name: "agent_poll",
        label: "Poll Agents",
        description:
            "Wait for child Agent progress or completion. /root/main is always included so new user input wakes the poll instead of leaving the main Agent deaf. Pass cursor from the previous result to wait only for newer events.",
        parameters: Type.Object({
            agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
            cursor: Type.Optional(Type.Number({ minimum: 0 })),
            timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
        }),
        async execute(_toolCallId, params, signal) {
            return toolResult(
                await runtime.poll(
                    {
                        ...(params.agents === undefined ? {} : { agents: params.agents }),
                        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
                        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
                    },
                    signal,
                ),
            );
        },
        renderCall: (args, theme, context) =>
            renderPiToolCall("agent_poll", args, theme, context),
        renderResult: (result, options, theme, context) =>
            renderPiToolResult("agent_poll", result, options, theme, context),
    });
    const interact = defineTool({
        name: "agent_interact",
        label: "Interact with Agent",
        description:
            "Send another message to a child Agent. interrupt=false queues a follow-up without interrupting active work; interrupt=true interrupts the current turn first and then sends the new instruction.",
        parameters: Type.Object({
            agent: Type.String({ minLength: 1 }),
            message: Type.String({ minLength: 1 }),
            interrupt: Type.Optional(Type.Boolean({ default: false })),
        }),
        async execute(_toolCallId, params) {
            return toolResult(
                await runtime.interact({
                    agent: params.agent,
                    message: params.message,
                    ...(params.interrupt === undefined ? {} : { interrupt: params.interrupt }),
                }),
            );
        },
        renderCall: (args, theme, context) =>
            renderPiToolCall("agent_interact", args, theme, context),
        renderResult: (result, options, theme, context) =>
            renderPiToolResult("agent_interact", result, options, theme, context),
    });
    const manage = defineTool({
        name: "agent_manage",
        label: "Manage Agent",
        description:
            "Perform low-frequency child Agent lifecycle actions. interrupt stops the current turn but keeps the Agent context reusable; terminate disposes the child Agent.",
        parameters: Type.Object({
            agent: Type.String({ minLength: 1 }),
            action: Type.Union([
                Type.Literal("interrupt"),
                Type.Literal("terminate"),
            ]),
        }),
        async execute(_toolCallId, params) {
            return toolResult(
                await runtime.manage({
                    action: params.action,
                    agent: params.agent,
                }),
            );
        },
        renderCall: (args, theme, context) =>
            renderPiToolCall("agent_manage", args, theme, context),
        renderResult: (result, options, theme, context) =>
            renderPiToolResult("agent_manage", result, options, theme, context),
    });
    return [spawn, poll, interact, manage];
}

function toolResult(details: unknown): {
    content: Array<{ text: string; type: "text" }>;
    details: JsonValue;
} {
    const json = details as JsonValue;
    return {
        content: [{ text: JSON.stringify(json), type: "text" }],
        details: json,
    };
}
