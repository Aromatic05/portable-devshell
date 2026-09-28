import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    contextTerminal,
    tools,
    type McpContextTerminalBinding,
    type McpContextTerminalEvent,
    type McpToolBinding,
    type McpToolInvocationContext,
    type McpToolResult,
} from "@portable-devshell/extension/mcp";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointSandboxInvocationContext,
    ExtensionPointValidationContext,
} from "../../../control/extension/generation/registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../../../control/extension/generation/sandbox/bridge/PointCodec.js";

export const mcpToolsSandboxCodec: ExtensionSandboxPointCodec = Object.freeze({
    describeBinding(
        binding: unknown,
        context: ExtensionPointValidationContext,
    ): ExtensionJsonValue {
        validateMcpToolBinding(binding, context);
        return Object.freeze({ kind: "tool" });
    },
    id: tools.id,
    async invokeBinding(
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        signal: AbortSignal,
        context: ExtensionPointSandboxInvocationContext,
    ): Promise<unknown> {
        validateMcpToolBinding(binding, context);
        const value = readRecord(input, "MCP tool invocation");
        const invocation = readRecord(
            value.context,
            "MCP tool invocation context",
        );
        return await (binding as McpToolBinding)(
            value.input ?? null,
            Object.freeze({
                callId: readString(invocation.callId, "callId"),
                instance: readString(invocation.instance, "instance"),
                signal,
                ...optionalString(invocation, "ctxId"),
                ...optionalString(invocation, "requestId"),
                ...optionalString(invocation, "workspace"),
            }),
        );
    },
});

export const mcpContextTerminalSandboxCodec: ExtensionSandboxPointCodec =
    Object.freeze({
        describeBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ): ExtensionJsonValue {
            validateMcpContextTerminalBinding(binding, context);
            return Object.freeze({ kind: "context-terminal" });
        },
        id: contextTerminal.id,
        async invokeBinding(
            binding: unknown,
            input: ExtensionJsonValue | undefined,
            _signal: AbortSignal,
            context: ExtensionPointSandboxInvocationContext,
        ): Promise<unknown> {
            validateMcpContextTerminalBinding(binding, context);
            const value = readRecord(input, "MCP Context terminal event");
            return await (binding as McpContextTerminalBinding)(
                Object.freeze({
                    ctxId: readString(value.ctxId, "ctxId"),
                    instance: readString(value.instance, "instance"),
                    reason: readTerminalReason(value.reason),
                }),
            );
        },
    });

export function createMcpToolSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): McpToolBinding {
    assertDescriptor(descriptor, context, "tool", tools.id);
    return async (
        input: ExtensionJsonValue,
        invocation: McpToolInvocationContext,
    ): Promise<McpToolResult> =>
        (await bridge.invokeBinding(
            tools.id,
            context.id,
            {
                context: {
                    callId: invocation.callId,
                    instance: invocation.instance,
                    ...(invocation.ctxId === undefined
                        ? {}
                        : { ctxId: invocation.ctxId }),
                    ...(invocation.requestId === undefined
                        ? {}
                        : { requestId: invocation.requestId }),
                    ...(invocation.workspace === undefined
                        ? {}
                        : { workspace: invocation.workspace }),
                },
                input,
            },
            {
                signal: invocation.signal,
                timeoutLabel: "MCP tool invocation",
            },
        )) as McpToolResult;
}

export function createMcpContextTerminalSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): McpContextTerminalBinding {
    assertDescriptor(
        descriptor,
        context,
        "context-terminal",
        contextTerminal.id,
    );
    return async (event: McpContextTerminalEvent): Promise<void> => {
        await bridge.invokeBinding(
            contextTerminal.id,
            context.id,
            {
                ctxId: event.ctxId,
                instance: event.instance,
                reason: event.reason,
            },
            { timeoutLabel: "MCP Context terminal callback" },
        );
    };
}

export function validateMcpToolBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is McpToolBinding {
    validateFunction(binding, context, tools.id);
}

export function validateMcpContextTerminalBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is McpContextTerminalBinding {
    validateFunction(binding, context, contextTerminal.id);
}

function validateFunction(
    binding: unknown,
    context: ExtensionPointValidationContext,
    pointId: string,
): asserts binding is (...args: never[]) => unknown {
    if (typeof binding !== "function")
        throw new TypeError(
            "Extension " +
                context.extensionId +
                " " +
                pointId +
                "/" +
                context.id +
                " binding must be a function.",
        );
}

function assertDescriptor(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    kind: string,
    pointId: string,
): void {
    const value = readRecord(
        descriptor,
        "Extension " +
            context.extensionId +
            " " +
            pointId +
            "/" +
            context.id +
            " sandbox descriptor",
    );
    if (
        value.kind !== kind ||
        Object.keys(value).some((key) => key !== "kind")
    )
        throw new TypeError(
            "Extension " +
                context.extensionId +
                " " +
                pointId +
                "/" +
                context.id +
                " sandbox descriptor is invalid.",
        );
}

function readRecord(
    value: ExtensionJsonValue | undefined,
    label: string,
): Record<string, ExtensionJsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value as Record<string, ExtensionJsonValue>;
    throw new TypeError(label + " must be an object.");
}

function readString(
    value: ExtensionJsonValue | undefined,
    field: string,
): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(field + " must be a non-empty string.");
}

function optionalString(
    record: Record<string, ExtensionJsonValue>,
    field: "ctxId" | "requestId" | "workspace",
): Partial<Record<typeof field, string>> {
    const value = record[field];
    return value === undefined ? {} : { [field]: readString(value, field) };
}

function readTerminalReason(
    value: ExtensionJsonValue | undefined,
): McpContextTerminalEvent["reason"] {
    if (value === "disabled" || value === "expired") return value;
    throw new TypeError(
        "MCP Context terminal reason must be disabled or expired.",
    );
}
