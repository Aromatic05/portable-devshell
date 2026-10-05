import {
    createRemoteError,
    contextErrorCodes,
    type ContextTransport,
    type ControlMcpContextMode,
    type JsonValue,
    type ContextExternalBinding,
    type ContextRecord,
} from "@portable-devshell/shared";

export interface McpContextRequestContext {
    principal: string;
    requestMeta?: Record<string, unknown>;
}

export interface McpResolvedContext {
    input: JsonValue;
    record: ContextRecord;
}

export interface McpContextSelector {
    readonly id: ControlMcpContextMode;
    readonly requiresExplicitContextId: boolean;
    bindings(
        requestContext: McpContextRequestContext,
    ): ContextExternalBinding[];
    expose(record: ContextRecord): Record<string, JsonValue>;
    resolve(
        contexts: Pick<ContextTransport, "resolve">,
        input: JsonValue,
        requestContext: McpContextRequestContext,
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
    ): ContextExternalBinding[] {
        if (this.id !== "openai-session") return [];
        const session = requestContext.requestMeta?.["openai/session"];
        return typeof session === "string" && session.length > 0
            ? [{ kind: "openai/session", value: session }]
            : [];
    }

    expose(record: ContextRecord): Record<string, JsonValue> {
        return this.requiresExplicitContextId ? { ctxId: record.ctxId } : {};
    }

    async resolve(
        contexts: Pick<ContextTransport, "resolve">,
        input: JsonValue,
        requestContext: McpContextRequestContext,
        options: { allowExpired?: boolean; touch?: boolean } = {},
    ): Promise<McpResolvedContext> {
        const contextInput = readOptionalMcpContextInput(input);
        if (this.requiresExplicitContextId) {
            if (contextInput.ctxId === undefined)
                throw missingExplicitContext();
            return {
                input: contextInput.input,
                record: await contexts.resolve({
                    acceptExpired: options.allowExpired === true,
                    ctxId: contextInput.ctxId,
                    principal: requestContext.principal,
                    touch: options.touch !== false,
                }),
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
        return {
            input: contextInput.input,
            record: await contexts.resolve({
                acceptExpired: options.allowExpired === true,
                externalBindings: this.bindings(requestContext),
                principal: requestContext.principal,
                renewExpired: options.touch !== false,
                touch: options.touch !== false,
            }),
        };
    }
}

export function readMcpContextInput(input: JsonValue): {
    ctxId: string;
    input: JsonValue;
} {
    const context = readOptionalMcpContextInput(input);
    if (context.ctxId === undefined) throw missingExplicitContext();
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

function missingExplicitContext() {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        message:
            "No Context is referenced by this request. Call environ_info with workspace or provide ctxId.",
        retryable: false,
    });
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
