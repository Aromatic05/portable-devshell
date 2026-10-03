import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    review,
    rewrite,
    type ToolCallContext,
    type ToolCallDirection,
    type ToolCallKind,
    type ToolCallReviewBinding,
    type ToolCallReviewContext,
    type ToolCallReviewInvocation,
    type ToolCallReviewResult,
    type ToolCallRewriteBinding,
    type ToolCallRewriteContext,
    type ToolCallRewriteInvocation,
    type ToolCallValue,
} from "@portable-devshell/extension/toolcall";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointSandboxInterfacePort,
    ExtensionPointSandboxInvocationContext,
    ExtensionPointValidationContext,
} from "../registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../sandbox/bridge/PointCodec.js";

export const toolCallReviewSandboxCodec: ExtensionSandboxPointCodec =
    Object.freeze({
        describeBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ): ExtensionJsonValue {
            validateToolCallReviewBinding(binding, context);
            return Object.freeze({ kind: "review" });
        },
        id: review.id,
        async invokeBinding(
            binding: unknown,
            input: ExtensionJsonValue | undefined,
            signal: AbortSignal,
            context: ExtensionPointSandboxInvocationContext,
        ): Promise<unknown> {
            validateToolCallReviewBinding(binding, context);
            return encodeReviewResult(
                await (binding as ToolCallReviewBinding)(
                    decodeReviewInvocation(input),
                    createSandboxReviewContext(context, signal),
                ),
            );
        },
    });

export const toolCallRewriteSandboxCodec: ExtensionSandboxPointCodec =
    Object.freeze({
        describeBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ): ExtensionJsonValue {
            validateToolCallRewriteBinding(binding, context);
            return Object.freeze({ kind: "rewrite" });
        },
        id: rewrite.id,
        async invokeBinding(
            binding: unknown,
            input: ExtensionJsonValue | undefined,
            signal: AbortSignal,
            context: ExtensionPointSandboxInvocationContext,
        ): Promise<unknown> {
            validateToolCallRewriteBinding(binding, context);
            return encodeToolCallValue(
                await (binding as ToolCallRewriteBinding)(
                    decodeRewriteInvocation(input),
                    createSandboxRewriteContext(context, signal),
                ),
            );
        },
    });

export function createToolCallReviewSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): ToolCallReviewBinding {
    assertDescriptor(descriptor, "review", context, review.id);
    return async (
        input: ToolCallReviewInvocation,
        invocation: ToolCallReviewContext,
    ): Promise<ToolCallReviewResult> =>
        decodeReviewResult(
            await bridge.invokeBinding(
                review.id,
                context.id,
                encodeReviewInvocation(input),
                {
                    interfacePort: createReviewInterfacePort(invocation),
                    signal: invocation.signal,
                },
            ),
        );
}

export function createToolCallRewriteSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): ToolCallRewriteBinding {
    assertDescriptor(descriptor, "rewrite", context, rewrite.id);
    return async (
        input: ToolCallRewriteInvocation,
        invocation: ToolCallRewriteContext,
    ): Promise<ToolCallValue> =>
        decodeToolCallValue(
            (await bridge.invokeBinding(
                rewrite.id,
                context.id,
                encodeRewriteInvocation(input),
                {
                    interfacePort: createRewriteInterfacePort(invocation),
                    signal: invocation.signal,
                },
            )) as ExtensionJsonValue | undefined,
            "ToolCall rewrite result",
        );
}

export function validateToolCallReviewBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is ToolCallReviewBinding {
    assertFunctionBinding(binding, context, review.id);
}

export function validateToolCallRewriteBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is ToolCallRewriteBinding {
    assertFunctionBinding(binding, context, rewrite.id);
}

function encodeReviewInvocation(
    input: ToolCallReviewInvocation,
): ExtensionJsonValue {
    return {
        callId: input.callId,
        direction: input.direction,
        value: encodeToolCallValue(input.value),
    };
}

function decodeReviewInvocation(
    input: ExtensionJsonValue | undefined,
): ToolCallReviewInvocation {
    const record = readRecord(input, "ToolCall review invocation");
    return Object.freeze({
        callId: readString(record.callId, "callId"),
        direction: readDirection(record.direction),
        value: decodeToolCallValue(record.value, "ToolCall review value"),
    });
}

function encodeRewriteInvocation(
    input: ToolCallRewriteInvocation,
): ExtensionJsonValue {
    return {
        callId: input.callId,
        direction: input.direction,
        value: encodeToolCallValue(input.value),
    };
}

function decodeRewriteInvocation(
    input: ExtensionJsonValue | undefined,
): ToolCallRewriteInvocation {
    const record = readRecord(input, "ToolCall rewrite invocation");
    return Object.freeze({
        callId: readString(record.callId, "callId"),
        direction: readDirection(record.direction),
        value: decodeToolCallValue(record.value, "ToolCall rewrite value"),
    });
}

function encodeToolCallValue(
    value: Readonly<ToolCallValue>,
): ExtensionJsonValue {
    return {
        context: encodeContext(value.context),
        kind: value.kind,
        payload: value.payload,
        toolName: value.toolName,
    };
}

function decodeToolCallValue(
    value: ExtensionJsonValue | undefined,
    label: string,
): ToolCallValue {
    const record = readRecord(value, label);
    return {
        context: decodeContext(record.context),
        kind: readKind(record.kind),
        payload: readJson(record.payload, `${label}.payload`),
        toolName: readString(record.toolName, `${label}.toolName`),
    };
}

function encodeReviewResult(result: ToolCallReviewResult): ExtensionJsonValue {
    return {
        decision: result.decision,
        ...(result.error === undefined
            ? {}
            : {
                  error: {
                      code: result.error.code,
                      ...(result.error.details === undefined
                          ? {}
                          : { details: result.error.details }),
                  },
              }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
}

function decodeReviewResult(value: unknown): ToolCallReviewResult {
    const record = readUnknownRecord(value, "ToolCall review result");
    const decision = record.decision;
    if (decision !== "continue" && decision !== "reject")
        throw new TypeError("ToolCall review decision is invalid.");
    const errorValue = record.error;
    return {
        decision,
        ...(errorValue === undefined
            ? {}
            : {
                  error: decodeReviewError(errorValue),
              }),
        ...(record.reason === undefined
            ? {}
            : { reason: readUnknownString(record.reason, "review reason") }),
    };
}

function decodeReviewError(value: unknown) {
    const record = readUnknownRecord(value, "ToolCall review error");
    return {
        code: readUnknownString(record.code, "review error code"),
        ...(record.details === undefined
            ? {}
            : { details: record.details as ExtensionJsonValue }),
    };
}

function encodeContext(context: ToolCallContext): ExtensionJsonValue {
    return {
        ...(context.ctxId === undefined ? {} : { ctxId: context.ctxId }),
        instance: context.instance,
        ...(context.operationId === undefined
            ? {}
            : { operationId: context.operationId }),
        ...(context.requestId === undefined
            ? {}
            : { requestId: context.requestId }),
        source: context.source,
        ...(context.workspace === undefined
            ? {}
            : { workspace: context.workspace }),
    };
}

function decodeContext(value: ExtensionJsonValue | undefined): ToolCallContext {
    const record = readRecord(value, "ToolCall context");
    return {
        ...(record.ctxId === undefined
            ? {}
            : { ctxId: readString(record.ctxId, "context.ctxId") }),
        instance: readString(record.instance, "context.instance"),
        ...(record.operationId === undefined
            ? {}
            : {
                  operationId: readString(
                      record.operationId,
                      "context.operationId",
                  ),
              }),
        ...(record.requestId === undefined
            ? {}
            : { requestId: readString(record.requestId, "context.requestId") }),
        source: readString(
            record.source,
            "context.source",
        ) as ToolCallContext["source"],
        ...(record.workspace === undefined
            ? {}
            : { workspace: readString(record.workspace, "context.workspace") }),
    };
}

function readDirection(
    value: ExtensionJsonValue | undefined,
): ToolCallDirection {
    if (value === "inbound" || value === "outbound") return value;
    throw new TypeError("ToolCall direction is invalid.");
}

function readKind(value: ExtensionJsonValue | undefined): ToolCallKind {
    if (
        value === "call" ||
        value === "error" ||
        value === "progress" ||
        value === "result"
    )
        return value;
    throw new TypeError("ToolCall kind is invalid.");
}

function readJson(
    value: ExtensionJsonValue | undefined,
    field: string,
): ExtensionJsonValue {
    if (value === undefined)
        throw new TypeError(`ToolCall ${field} is required.`);
    return value;
}

function readString(
    value: ExtensionJsonValue | undefined,
    field: string,
): string {
    if (typeof value === "string") return value;
    throw new TypeError(`ToolCall ${field} must be a string.`);
}

function readUnknownString(value: unknown, field: string): string {
    if (typeof value === "string") return value;
    throw new TypeError(`ToolCall ${field} must be a string.`);
}

function readRecord(
    value: ExtensionJsonValue | undefined,
    label: string,
): Record<string, ExtensionJsonValue | undefined> {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value;
    throw new TypeError(`${label} must be an object.`);
}

function readUnknownRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value as Record<string, unknown>;
    throw new TypeError(`${label} must be an object.`);
}

function createSandboxRewriteContext(
    context: ExtensionPointSandboxInvocationContext,
    signal: AbortSignal,
): ToolCallRewriteContext {
    return {
        signal,
        requestInterface: async (
            operation: string,
            input?: ExtensionJsonValue,
        ) => await context.requestInterface(operation, input),
    };
}

function createRewriteInterfacePort(
    context: ToolCallRewriteContext,
): ExtensionPointSandboxInterfacePort {
    return {
        request: async (operation: string, input?: ExtensionJsonValue) =>
            await context.requestInterface(operation, input),
    };
}

function createSandboxReviewContext(
    context: ExtensionPointSandboxInvocationContext,
    signal: AbortSignal,
): ToolCallReviewContext {
    return {
        signal,
        requestInterface: async (
            operation: string,
            input?: ExtensionJsonValue,
        ) => await context.requestInterface(operation, input),
    };
}

function createReviewInterfacePort(
    context: ToolCallReviewContext,
): ExtensionPointSandboxInterfacePort {
    return {
        request: async (operation: string, input?: ExtensionJsonValue) =>
            await context.requestInterface(operation, input),
    };
}

function assertDescriptor(
    descriptor: ExtensionJsonValue,
    kind: string,
    context: ExtensionPointValidationContext,
    pointId: string,
): void {
    const value = readRecord(descriptor, `${pointId} descriptor`);
    if (value.kind !== kind)
        throw new TypeError(
            `Extension ${context.extensionId} ${pointId}/${context.id} descriptor is invalid.`,
        );
}

function assertFunctionBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
    pointId: string,
): void {
    if (typeof binding !== "function")
        throw new TypeError(
            `Extension ${context.extensionId} ${pointId}/${context.id} binding must be a function.`,
        );
}
