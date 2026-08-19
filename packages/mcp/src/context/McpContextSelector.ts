import {
    createError,
    errorCodes,
    type ControlMcpContextMode,
    type JsonValue,
    type McpContextRecord,
} from "@portable-devshell/shared";

import { readMcpContextInput } from "../endpoint/McpEndpointInput.js";
import type { McpEndpointCallContext } from "../endpoint/McpEndpointPort.js";
import {
    McpContextRegistry,
    type McpContextExternalSelector,
} from "./McpContextRegistry.js";

export interface McpResolvedContext {
    input: JsonValue;
    record: McpContextRecord;
}

export interface McpContextSelector {
    readonly id: ControlMcpContextMode;
    readonly requiresExplicitContextId: boolean;
    binding(requestContext: McpEndpointCallContext): McpContextExternalSelector | undefined;
    expose(record: McpContextRecord): Record<string, JsonValue>;
    resolve(
        registry: McpContextRegistry,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        instanceName: string,
    ): Promise<McpResolvedContext>;
}

export function createMcpContextSelector(mode: ControlMcpContextMode): McpContextSelector {
    return mode === "openai-session"
        ? new OpenAiSessionContextSelector()
        : new ExplicitContextSelector();
}

class ExplicitContextSelector implements McpContextSelector {
    readonly id = "explicit" as const;
    readonly requiresExplicitContextId = true;

    binding(): undefined {
        return undefined;
    }

    expose(record: McpContextRecord): Record<string, JsonValue> {
        return { ctxId: record.ctxId };
    }

    async resolve(
        registry: McpContextRegistry,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
    ): Promise<McpResolvedContext> {
        const contextInput = readMcpContextInput(input);
        return {
            input: contextInput.input,
            record: await registry.validateAndTouch(contextInput.ctxId, {
                principal: requestContext.principal,
            }),
        };
    }
}

class OpenAiSessionContextSelector implements McpContextSelector {
    readonly id = "openai-session" as const;
    readonly requiresExplicitContextId = false;

    binding(requestContext: McpEndpointCallContext): McpContextExternalSelector {
        return {
            kind: "openai/session",
            value: requireOpenAiSession(requestContext),
        };
    }

    expose(): Record<string, JsonValue> {
        return {};
    }

    async resolve(
        registry: McpContextRegistry,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        instanceName: string,
    ): Promise<McpResolvedContext> {
        return {
            input,
            record: await registry.validateAndTouchSelector(this.binding(requestContext), {
                instance: instanceName,
                principal: requestContext.principal,
            }),
        };
    }
}

function requireOpenAiSession(context: McpEndpointCallContext): string {
    const value = context.requestMeta?.["openai/session"];
    if (typeof value === "string" && value.length > 0) return value;
    throw createError({
        code: errorCodes.mcpContextInvalid,
        message: "This endpoint uses OpenAI session context mode, but the client did not provide _meta['openai/session'].",
        retryable: false,
    });
}
