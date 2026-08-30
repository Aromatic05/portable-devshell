import {
    createError,
    errorCodes,
    type ControlMcpContextMode,
    type JsonValue,
    type McpContextRecord,
} from "@portable-devshell/shared";

import { readOptionalMcpContextInput } from "../endpoint/McpEndpointInput.js";
import type { McpEndpointCallContext } from "../endpoint/McpEndpointPort.js";
import {
    McpContextRegistry,
    type McpContextExternalBinding,
} from "./McpContextRegistry.js";

export interface McpResolvedContext {
    input: JsonValue;
    record: McpContextRecord;
}

export interface McpContextSelector {
    readonly id: ControlMcpContextMode;
    readonly requiresExplicitContextId: boolean;
    bindings(
        requestContext: McpEndpointCallContext,
    ): McpContextExternalBinding[];
    expose(record: McpContextRecord): Record<string, JsonValue>;
    resolve(
        registry: McpContextRegistry,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        instanceName: string,
        options?: { touch?: boolean },
    ): Promise<McpResolvedContext>;
}

export function createMcpContextSelector(
    mode: ControlMcpContextMode = "explicit",
): McpContextSelector {
    return new UnifiedContextSelector(mode);
}

class UnifiedContextSelector implements McpContextSelector {
    readonly id: ControlMcpContextMode;
    readonly requiresExplicitContextId: boolean;

    constructor(mode: ControlMcpContextMode) {
        this.id = mode;
        this.requiresExplicitContextId = mode === "explicit";
    }

    bindings(
        requestContext: McpEndpointCallContext,
    ): McpContextExternalBinding[] {
        if (this.id !== "openai-session") return [];
        const session = requestContext.requestMeta?.["openai/session"];
        return typeof session === "string" && session.length > 0
            ? [{ kind: "openai/session", value: session }]
            : [];
    }

    expose(record: McpContextRecord): Record<string, JsonValue> {
        return { ctxId: record.ctxId };
    }

    async resolve(
        registry: McpContextRegistry,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        _instanceName: string,
        options?: { touch?: boolean },
    ): Promise<McpResolvedContext> {
        const validate = async (ctxId: string) => options?.touch === false
            ? await registry.validate(ctxId, { principal: requestContext.principal })
            : await registry.validateAndTouch(ctxId, { principal: requestContext.principal });
        const contextInput = readOptionalMcpContextInput(input);
        if (contextInput.ctxId !== undefined) {
            return {
                input: contextInput.input,
                record: await validate(contextInput.ctxId),
            };
        }
        let boundCtxId: string | undefined;
        for (const binding of this.bindings(requestContext)) {
            const record = await registry.lookupExternal(binding, {
                principal: requestContext.principal,
            });
            if (record === undefined) continue;
            if (boundCtxId !== undefined && boundCtxId !== record.ctxId) {
                throw createError({
                    code: errorCodes.mcpContextInvalid,
                    message: "External Context bindings disagree on ctxId.",
                    retryable: false,
                });
            }
            boundCtxId = record.ctxId;
        }
        if (boundCtxId !== undefined) {
            return {
                input: contextInput.input,
                record: await validate(boundCtxId),
            };
        }
        throw createError({
            code: errorCodes.mcpContextInvalid,
            message:
                "No Context is bound to this request. Call context_acquire or provide ctxId.",
            retryable: false,
        });
    }
}
