import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    review,
    rewrite,
    type ToolCallContext,
    type ToolCallDirection,
    type ToolCallPayloadKind,
    type ToolCallReviewBinding,
    type ToolCallReviewContext,
    type ToolCallReviewInvocation,
    type ToolCallReviewResult,
    type ToolCallRewriteBinding,
    type ToolCallRewriteContext,
    type ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointSandboxInterfacePort,
    ExtensionPointSandboxInvocationContext,
    ExtensionPointValidationContext,
} from "../generation/registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../generation/sandbox/bridge/PointCodec.js";

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
                    decodeReviewInvocation(input, signal),
                    createSandboxReviewContext(context),
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
            const result = await (binding as ToolCallRewriteBinding)(
                decodeRewriteInvocation(input, signal),
                createSandboxRewriteContext(context),
            );
            if (typeof result !== "string")
                throw new TypeError("ToolCall rewrite binding must return a string.");
            return result;
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
                    signal: input.signal,
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
    ): Promise<string> => {
        const result = await bridge.invokeBinding(
            rewrite.id,
            context.id,
            encodeRewriteInvocation(input),
            {
                interfacePort: createRewriteInterfacePort(invocation),
                signal: input.signal,
            },
        );
        if (typeof result !== "string")
            throw new TypeError("ToolCall rewrite sandbox result must be a string.");
        return result;
    };
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

function encodeReviewInvocation(input: ToolCallReviewInvocation): ExtensionJsonValue {
    return {
        context: encodeContext(input.context),
        direction: input.direction,
        kind: input.kind,
        payload: input.payload,
        toolName: input.toolName,
    };
}

function decodeReviewInvocation(
    input: ExtensionJsonValue | undefined,
    signal: AbortSignal,
): ToolCallReviewInvocation {
    const value = readRecord(input, "ToolCall review invocation");
    return Object.freeze({
        context: decodeContext(value.context),
        direction: readDirection(value.direction),
        kind: readKind(value.kind),
        payload: readJson(value.payload, "payload"),
        signal,
        toolName: readString(value.toolName, "toolName"),
    });
}

function encodeRewriteInvocation(input: ToolCallRewriteInvocation): ExtensionJsonValue {
    return {
        context: encodeContext(input.context),
        direction: input.direction,
        kind: input.kind,
        path: [...input.path],
        text: input.text,
        toolName: input.toolName,
    };
}

function decodeRewriteInvocation(
    input: ExtensionJsonValue | undefined,
    signal: AbortSignal,
): ToolCallRewriteInvocation {
    const value = readRecord(input, "ToolCall rewrite invocation");
    return Object.freeze({
        context: decodeContext(value.context),
        direction: readDirection(value.direction),
        kind: readKind(value.kind),
        path: readPath(value.path),
        signal,
        text: readString(value.text, "text"),
        toolName: readString(value.toolName, "toolName"),
    });
}

function encodeReviewResult(result: ToolCallReviewResult): ExtensionJsonValue {
    const decoded = decodeReviewResult(result);
    return {
        decision: decoded.decision,
        ...(decoded.error === undefined
            ? {}
            : {
                  error: {
                      code: decoded.error.code,
                      ...(decoded.error.details === undefined
                          ? {}
                          : { details: decoded.error.details }),
                  },
              }),
        ...(decoded.reason === undefined ? {} : { reason: decoded.reason }),
    };
}

function decodeReviewResult(value: unknown): ToolCallReviewResult {
    const record = readUnknownRecord(value, "ToolCall review result");
    const decision = record.decision;
    if (decision !== "accept" && decision !== "approve" && decision !== "reject")
        throw new TypeError("ToolCall review decision is invalid.");
    const reason = record.reason;
    if (reason !== undefined && typeof reason !== "string")
        throw new TypeError("ToolCall review reason must be a string.");
    const errorValue = record.error;
    let error: ToolCallReviewResult["error"];
    if (errorValue !== undefined) {
        const errorRecord = readUnknownRecord(
            errorValue,
            "ToolCall review error",
        );
        if (typeof errorRecord.code !== "string" || errorRecord.code.length === 0)
            throw new TypeError(
                "ToolCall review error code must be a non-empty string.",
            );
        error = Object.freeze({
            code: errorRecord.code,
            ...(errorRecord.details === undefined
                ? {}
                : {
                      details: readJson(
                          errorRecord.details as ExtensionJsonValue,
                          "review error details",
                      ),
                  }),
        });
    }
    return Object.freeze({
        decision,
        ...(error === undefined ? {} : { error }),
        ...(reason === undefined ? {} : { reason }),
    });
}

function encodeContext(context: ToolCallContext): ExtensionJsonValue {
    return {
        ...(context.ctxId === undefined ? {} : { ctxId: context.ctxId }),
        instance: context.instance,
        ...(context.extensionId === undefined
            ? {}
            : { extensionId: context.extensionId }),
        ...(context.operationId === undefined
            ? {}
            : { operationId: context.operationId }),
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        source: context.source,
        ...(context.workspace === undefined ? {} : { workspace: context.workspace }),
    };
}

function decodeContext(value: ExtensionJsonValue | undefined): ToolCallContext {
    const record = readRecord(value, "ToolCall context");
    const source = readString(record.source, "context.source");
    if (!new Set(["cli", "extension", "mcp", "tui", "web"]).has(source))
        throw new TypeError("ToolCall context.source is invalid.");
    return Object.freeze({
        ...(record.ctxId === undefined ? {} : { ctxId: readString(record.ctxId, "context.ctxId") }),
        instance: readString(record.instance, "context.instance"),
        ...(record.extensionId === undefined ? {} : { extensionId: readString(record.extensionId, "context.extensionId") }),
        ...(record.operationId === undefined ? {} : { operationId: readString(record.operationId, "context.operationId") }),
        ...(record.requestId === undefined ? {} : { requestId: readString(record.requestId, "context.requestId") }),
        source: source as ToolCallContext["source"],
        ...(record.workspace === undefined ? {} : { workspace: readString(record.workspace, "context.workspace") }),
    });
}

function readDirection(value: ExtensionJsonValue | undefined): ToolCallDirection {
    if (value === "inbound" || value === "outbound") return value;
    throw new TypeError("ToolCall direction is invalid.");
}

function readKind(value: ExtensionJsonValue | undefined): ToolCallPayloadKind {
    if (value === "call" || value === "error" || value === "progress" || value === "result")
        return value;
    throw new TypeError("ToolCall payload kind is invalid.");
}

function readPath(value: ExtensionJsonValue | undefined): readonly (number | string)[] {
    if (!Array.isArray(value)) throw new TypeError("ToolCall rewrite path must be an array.");
    const result = value.map((entry) => {
        if (typeof entry === "string") return entry;
        if (typeof entry === "number" && Number.isSafeInteger(entry)) return entry;
        throw new TypeError("ToolCall rewrite path entries must be strings or integers.");
    });
    return Object.freeze(result);
}

function readJson(value: ExtensionJsonValue | undefined, field: string): ExtensionJsonValue {
    if (value === undefined) throw new TypeError(`ToolCall ${field} is required.`);
    return value;
}

function readString(value: ExtensionJsonValue | undefined, field: string): string {
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

function readUnknownRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value as Record<string, unknown>;
    throw new TypeError(`${label} must be an object.`);
}

function createSandboxRewriteContext(
    context: ExtensionPointSandboxInvocationContext,
): ToolCallRewriteContext {
    return Object.freeze({
        requestInterface: async (
            operation: string,
            input?: ExtensionJsonValue,
        ) => await context.requestInterface(operation, input),
    });
}

function createRewriteInterfacePort(
    context: ToolCallRewriteContext,
): ExtensionPointSandboxInterfacePort {
    return Object.freeze({
        request: async (
            operation: string,
            input?: ExtensionJsonValue,
        ) => await context.requestInterface(operation, input),
    });
}

function createSandboxReviewContext(
    context: ExtensionPointSandboxInvocationContext,
): ToolCallReviewContext {
    return Object.freeze({
        requestInterface: async (
            operation: string,
            input?: ExtensionJsonValue,
        ) => await context.requestInterface(operation, input),
    });
}

function createReviewInterfacePort(
    context: ToolCallReviewContext,
): ExtensionPointSandboxInterfacePort {
    return Object.freeze({
        request: async (
            operation: string,
            input?: ExtensionJsonValue,
        ) => await context.requestInterface(operation, input),
    });
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
