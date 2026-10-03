import {
    createRemoteError,
    contextErrorCodes,
    type ControlMcpContextMode,
    type JsonValue,
    type McpContextRecord,
} from "@portable-devshell/shared";

import type {
    ContextRegistryPort,
    McpContextExternalBinding,
} from "@portable-devshell/shared";

export interface McpContextRequestContext {
    principal: string;
    requestMeta?: Record<string, unknown>;
}

export interface McpResolvedContext {
    input: JsonValue;
    record: McpContextRecord;
}

export interface McpContextSelector {
    readonly id: ControlMcpContextMode;
    readonly requiresExplicitContextId: boolean;
    bindings(
        requestContext: McpContextRequestContext,
    ): McpContextExternalBinding[];
    expose(record: McpContextRecord): Record<string, JsonValue>;
    resolve(
        registry: ContextRegistryPort,
        input: JsonValue,
        requestContext: McpContextRequestContext,
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
        requestContext: McpContextRequestContext,
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
        registry: ContextRegistryPort,
        input: JsonValue,
        requestContext: McpContextRequestContext,
        _instanceName: string,
        options?: { allowExpired?: boolean; touch?: boolean },
    ): Promise<McpResolvedContext> {
        const validate = async (ctxId: string) => {
            if (options?.touch !== false) {
                return await registry.validateAndTouch(ctxId, {
                    principal: requestContext.principal,
                });
            }
            if (options.allowExpired === true) {
                const record = await registry.lookup(ctxId, {
                    principal: requestContext.principal,
                });
                if (record.status === "disabled") {
                    return await registry.validate(ctxId, {
                        principal: requestContext.principal,
                    });
                }
                return record;
            }
            return await registry.validate(ctxId, {
                principal: requestContext.principal,
            });
        };
        const contextInput = readOptionalMcpContextInput(input);
        if (this.requiresExplicitContextId) {
            if (contextInput.ctxId === undefined) {
                throw createRemoteError({
                    code: contextErrorCodes.invalid,
                    message:
                        "No Context is referenced by this request. Call environ_info with workspace or provide ctxId.",
                    retryable: false,
                });
            }
            return {
                input: contextInput.input,
                record: await validate(contextInput.ctxId),
            };
        }
        if (contextInput.ctxId !== undefined) {
            throw createRemoteError({
                code: contextErrorCodes.invalid,
                message:
                    "ctxId is internal when Context authority is externally bound.",
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
                throw createRemoteError({
                    code: contextErrorCodes.invalid,
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
        throw createRemoteError({
            code: contextErrorCodes.invalid,
            message:
                "No Context is bound to this request. Call environ_info with workspace.",
            retryable: false,
        });
    }
}

export function readMcpContextInput(input: JsonValue): {
    ctxId: string;
    input: JsonValue;
} {
    const context = readOptionalMcpContextInput(input);
    if (context.ctxId === undefined) {
        throw createRemoteError({
            code: contextErrorCodes.invalid,
            message:
                "No Context is referenced by this request. Call environ_info with workspace or provide ctxId.",
            retryable: false,
        });
    }
    return { ctxId: context.ctxId, input: context.input };
}

export function readOptionalMcpContextInput(input: JsonValue): {
    ctxId?: string;
    input: JsonValue;
} {
    if (!isRecord(input) || input.ctxId === undefined) return { input };
    if (typeof input.ctxId !== "string" || input.ctxId.trim().length === 0) {
        throw createRemoteError({
            code: contextErrorCodes.invalid,
            message: "ctxId must be a non-empty Context ID.",
            retryable: false,
        });
    }
    const { ctxId, ...toolInput } = input;
    return { ctxId: ctxId.trim(), input: toolInput };
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
