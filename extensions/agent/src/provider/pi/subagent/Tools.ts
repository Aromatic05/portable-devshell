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
    return [
        {
            name: "agent_spawn",
            label: "Spawn Agent",
            description:
                "Spawn an isolated child Agent under /root/main. Use a short semantic name and a focused task. profile selects an optional Agent Profile. fork=false creates a clean context; fork=true is reserved and currently unsupported.",
            parameters: asSchema(
                Type.Object({
                    name: Type.String({ minLength: 1 }),
                    task: Type.String({ minLength: 1 }),
                    profile: Type.Optional(Type.String({ minLength: 1 })),
                    fork: Type.Optional(Type.Boolean({ default: false })),
                }),
            ),
            async execute(_toolCallId, params) {
                const input = asRecord(params);
                const result = await runtime.spawn({
                    name: requiredString(input, "name"),
                    task: requiredString(input, "task"),
                    ...(typeof input.profile === "string"
                        ? { profile: input.profile }
                        : {}),
                    ...(typeof input.fork === "boolean"
                        ? { fork: input.fork }
                        : {}),
                });
                return toolResult(result);
            },
            renderCall: (args, theme, context) =>
                renderPiToolCall("agent_spawn", args, theme, context),
            renderResult: (result, options, theme, context) =>
                renderPiToolResult(
                    "agent_spawn",
                    result,
                    options,
                    theme,
                    context,
                ),
        },
        {
            name: "agent_poll",
            label: "Poll Agents",
            description:
                "Wait for child Agent progress or completion. /root/main is always included so new user input wakes the poll instead of leaving the main Agent deaf. Pass cursor from the previous result to wait only for newer events.",
            parameters: asSchema(
                Type.Object({
                    agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
                    cursor: Type.Optional(Type.Number({ minimum: 0 })),
                    timeoutMs: Type.Optional(
                        Type.Number({ minimum: 0, maximum: 60_000 }),
                    ),
                }),
            ),
            async execute(_toolCallId, params, signal) {
                const input = asRecord(params);
                const result = await runtime.poll(
                    {
                        ...(Array.isArray(input.agents)
                            ? {
                                  agents: input.agents.filter(
                                      (value): value is string =>
                                          typeof value === "string",
                                  ),
                              }
                            : {}),
                        ...(typeof input.cursor === "number"
                            ? { cursor: input.cursor }
                            : {}),
                        ...(typeof input.timeoutMs === "number"
                            ? { timeoutMs: input.timeoutMs }
                            : {}),
                    },
                    signal,
                );
                return toolResult(result);
            },
            renderCall: (args, theme, context) =>
                renderPiToolCall("agent_poll", args, theme, context),
            renderResult: (result, options, theme, context) =>
                renderPiToolResult(
                    "agent_poll",
                    result,
                    options,
                    theme,
                    context,
                ),
        },
        {
            name: "agent_interact",
            label: "Interact with Agent",
            description:
                "Send another message to a child Agent. interrupt=false queues a follow-up without interrupting active work; interrupt=true interrupts the current turn first and then sends the new instruction.",
            parameters: asSchema(
                Type.Object({
                    agent: Type.String({ minLength: 1 }),
                    message: Type.String({ minLength: 1 }),
                    interrupt: Type.Optional(Type.Boolean({ default: false })),
                }),
            ),
            async execute(_toolCallId, params) {
                const input = asRecord(params);
                const result = await runtime.interact({
                    agent: requiredString(input, "agent"),
                    message: requiredString(input, "message"),
                    ...(typeof input.interrupt === "boolean"
                        ? { interrupt: input.interrupt }
                        : {}),
                });
                return toolResult(result);
            },
            renderCall: (args, theme, context) =>
                renderPiToolCall("agent_interact", args, theme, context),
            renderResult: (result, options, theme, context) =>
                renderPiToolResult(
                    "agent_interact",
                    result,
                    options,
                    theme,
                    context,
                ),
        },
        {
            name: "agent_manage",
            label: "Manage Agent",
            description:
                "Perform low-frequency child Agent lifecycle actions. interrupt stops the current turn but keeps the Agent context reusable; terminate disposes the child Agent.",
            parameters: asSchema(
                Type.Object({
                    agent: Type.String({ minLength: 1 }),
                    action: Type.Union([
                        Type.Literal("interrupt"),
                        Type.Literal("terminate"),
                    ]),
                }),
            ),
            async execute(_toolCallId, params) {
                const input = asRecord(params);
                const action = input.action;
                if (action !== "interrupt" && action !== "terminate")
                    throw new Error("agent_manage action must be interrupt or terminate.");
                const result = await runtime.manage({
                    action,
                    agent: requiredString(input, "agent"),
                });
                return toolResult(result);
            },
            renderCall: (args, theme, context) =>
                renderPiToolCall("agent_manage", args, theme, context),
            renderResult: (result, options, theme, context) =>
                renderPiToolResult(
                    "agent_manage",
                    result,
                    options,
                    theme,
                    context,
                ),
        },
    ];
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

function requiredString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`${key} must be a non-empty string.`);
    return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Agent tool input must be an object.");
    return value as Record<string, unknown>;
}

function asSchema(value: unknown): JsonValue {
    return value as JsonValue;
}
