import {
    createError,
    errorCodes,
    type ControlMcpContextMode,
    type JsonValue,
    type McpContextRecord,
} from "@portable-devshell/shared";

import { readOptionalMcpContextInput } from "../endpoint/dispatch/Input.js";
import type { McpEndpointCallContext } from "../endpoint/Port.js";
import {
    McpContextRegistry,
    type McpContextExternalBinding,
} from "./registry/Registry.js";

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
        options?: { allowExpired?: boolean; touch?: boolean },
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
        return this.requiresExplicitContextId ? { ctxId: record.ctxId } : {};
    }

    async resolve(
        registry: McpContextRegistry,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        _instanceName: string,
        options?: { allowExpired?: boolean; touch?: boolean },
    ): Promise<McpResolvedContext> {
        const validate = async (ctxId: string) => {
            if (options?.touch !== false) {
                return await registry.validateAndTouch(ctxId, { principal: requestContext.principal });
            }
            if (options.allowExpired === true) {
                const record = await registry.lookup(ctxId, { principal: requestContext.principal });
                if (record.status === "disabled") {
                    return await registry.validate(ctxId, { principal: requestContext.principal });
                }
                return record;
            }
            return await registry.validate(ctxId, { principal: requestContext.principal });
        };
        const contextInput = readOptionalMcpContextInput(input);
        if (this.requiresExplicitContextId) {
            if (contextInput.ctxId === undefined) {
                throw createError({
                    code: errorCodes.mcpContextInvalid,
                    message: "No Context is referenced by this request. Call environ_info with workspace or provide ctxId.",
                    retryable: false,
                });
            }
            return {
                input: contextInput.input,
                record: await validate(contextInput.ctxId),
            };
        }
        if (contextInput.ctxId !== undefined) {
            throw createError({
                code: errorCodes.mcpContextInvalid,
                message: "ctxId is internal when Context authority is externally bound.",
                retryable: false,
            });
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
            const bound = await registry.lookup(boundCtxId, {
                principal: requestContext.principal,
            });
            return {
                input: contextInput.input,
                record:
                    bound.status === "expired" && options?.touch !== false
                        ? await registry.renewForPrincipal(boundCtxId, {
                              principal: requestContext.principal,
                          })
                        : await validate(boundCtxId),
            };
        }
        throw createError({
            code: errorCodes.mcpContextInvalid,
            message: "No Context is bound to this request. Call environ_info with workspace.",
            retryable: false,
        });
    }
}
