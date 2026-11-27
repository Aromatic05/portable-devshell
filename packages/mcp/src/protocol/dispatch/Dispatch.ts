import {
    bootstrapToolNamespace,
    contextErrorCodes,
    createRemoteError,
    statelessMcpContextId,
    toolNamespace,
    type ContextTransport,
    type ToolCallApi,
    type ToolCallHookValue,
    type JsonValue,
    type ContextEnvironment,
    type ContextRecord,
    type ToolCallContext,
    type ToolCallProvenance,
} from "@portable-devshell/shared";

import {
    createMcpContextSelector,
    readMcpContextInput,
    type McpContextSelector,
} from "../context/Selector.js";
import {
    presentMcpEndpointResult,
    throwIfMcpEndpointAborted,
} from "../call/Boundary.js";
import type { McpEndpointCatalog } from "../tool/Catalog.js";
import {
    readMcpProvenanceInput,
    readMcpRoutedInput,
} from "../tool/Input.js";
import type { McpEndpointCallContext } from "../call/Port.js";
import { McpNativeToolResult, type McpEndpointResult } from "../call/Boundary.js";
import type { McpToolProvenanceRecorder } from "../tool/Provenance.js";
import { mcpEndpointToolNotExposed } from "../call/Boundary.js";

export type { McpEndpointCallContext } from "../call/Port.js";

export interface McpEndpointDispatchOptions {
    catalog: McpEndpointCatalog;
    context: Pick<ContextTransport, "resolve">;
    contextSelector?: McpContextSelector;
    instanceName: string;
    toolProvenance?: McpToolProvenanceRecorder;
    tools: ToolCallApi;
}

interface McpAcceptedCall {
    value: ToolCallHookValue;
    workspaceAdvice: string[];
}

export class McpEndpointDispatch {
    readonly #catalog: McpEndpointCatalog;
    readonly #context: Pick<ContextTransport, "resolve">;
    readonly #contextSelector: McpContextSelector;
    readonly #instanceName: string;
    readonly #toolProvenance?: McpToolProvenanceRecorder;
    readonly #tools: ToolCallApi;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#context = options.context;
        this.#contextSelector =
            options.contextSelector ?? createMcpContextSelector("explicit");
        this.#instanceName = options.instanceName;
        this.#toolProvenance = options.toolProvenance;
        this.#tools = options.tools;
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
        onExecuted?: (callId: string, value: Readonly<ToolCallHookValue>, result: JsonValue) => void,
        onProgress?: (progress: JsonValue) => void,
    ): Promise<McpEndpointResult> {
        throwIfMcpEndpointAborted(signal);
        const snapshot = this.#catalog.snapshot();
        const selected = snapshot.entries.find(
            (entry) => entry.definition.name === toolName,
        );

        if (selected === undefined) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }

        if (toolNamespace(toolName) === bootstrapToolNamespace) {
            return await this.#tools.call(
                this.#instanceName,
                toolName,
                input,
                {
                    contextMode: this.#contextSelector.id,
                    externalBindings:
                        this.#contextSelector.bindings(requestContext),
                    principal: requestContext.principal,
                    requestId: requestContext.requestId,
                    source: "mcp",
                },
                signal,
            );
        }

        const appOnlyInteraction = isAppOnlyInteractionTool(toolName);
        const provenanceInput = readMcpProvenanceInput(input);
        input = provenanceInput.input;
        const stateless = this.#contextSelector.id === "stateless";
        const resolvedContext = stateless ? undefined : appOnlyInteraction
            ? await this.#resolveAppOnlyContext(
                  input,
                  requestContext,
              )
            : await this.#contextSelector.resolve(
                  this.#context,
                  input,
                  requestContext,
                  {
                      touch: false,
                  },
              );
        if (resolvedContext !== undefined) input = resolvedContext.input;
        const routed =
            selected.scope !== "*"
                ? readMcpRoutedInput(
                      input,
                      snapshot.instanceRoutingEnabled,
                      this.#instanceName,
                  )
                : { input, instance: this.#instanceName };
        if (routed.instance !== this.#instanceName && resolvedContext !== undefined) {
            // Validate an explicit target before entering ToolCall ingress.
            // A missing or masked attachment must never reach a Worker.
            await this.#context.resolve({
                ctxId: resolvedContext.record.ctxId,
                instance: routed.instance,
                principal: requestContext.principal,
                touch: false,
            });
        }
        const context: ToolCallContext = resolvedContext === undefined ? {
            contextMode: "stateless",
            ctxId: statelessMcpContextId,
            principal: requestContext.principal,
            requestId: requestContext.requestId,
            source: "mcp",
        } : this.#createToolContext(
            resolvedContext.record,
            requestContext,
            routed.instance,
            signal,
        );
        let accepted: McpAcceptedCall | undefined;
        let nativeResult = false;
        const prepareCall = async (
            callId: string,
            finalValue: ToolCallHookValue,
        ): Promise<McpAcceptedCall> => {
            accepted = await this.#prepareCall(
                callId,
                finalValue,
                toolName,
                requestContext,
                provenanceInput.provenance,
            );
            return accepted;
        };
        const result = await this.#tools.call(
                routed.instance,
                toolName,
                routed.input,
                context,
                signal,
                async (structured, _callId, nextPresentation) => {
                    nativeResult = nextPresentation !== undefined;
                    if (accepted !== undefined) onExecuted?.(_callId, accepted.value, structured);
                    return structured;
                },
                async (rewrittenInput, callId, value) => {
                    await prepareCall(callId, value);
                    return rewrittenInput;
                },
                onProgress,
            );
        return appendWorkspaceAdvice(
            presentMcpEndpointResult(result, nativeResult),
            accepted?.workspaceAdvice ?? [],
        );
    }

    async #prepareCall(
        callId: string,
        value: ToolCallHookValue,
        toolName: string,
        requestContext: McpEndpointCallContext,
        provenance: ToolCallProvenance,
    ): Promise<McpAcceptedCall> {
        const { instance, ctxId } = value.context;
        if (this.#contextSelector.id === "stateless") {
            if (instance !== this.#instanceName || value.toolName !== toolName ||
                ctxId !== statelessMcpContextId || value.context.contextMode !== "stateless" ||
                value.context.workspace !== undefined) {
                throw createRemoteError({
                    code: contextErrorCodes.invalid,
                    message: "Stateless tool calls cannot change tool, instance, or Context.",
                    retryable: false,
                });
            }
        } else {
            await this.#context.resolve({
                ctxId: ctxId!,
                instance,
                principal: requestContext.principal,
                touch: true,
            });
        }
        const workspaceAdvice: string[] = [];
        if (hasToolProvenance(provenance) && this.#toolProvenance !== undefined) {
            await this.#toolProvenance.record({ callId, ...provenance, instance }).catch(() => undefined);
        }
        return { value, workspaceAdvice };
    }


    #createToolContext(
        record: ContextRecord,
        requestContext: McpEndpointCallContext,
        instance: string,
        signal?: AbortSignal,
    ): ToolCallContext {
        const environment = contextEnvironment(record, instance);
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp",
            ...(environment?.workspace === undefined
                ? {}
                : { workspace: environment.workspace }),
        };
        throwIfMcpEndpointAborted(signal);
        return context;
    }

    async #resolveAppOnlyContext(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
    ): Promise<{ input: JsonValue; record: ContextRecord }> {
        const contextInput = readMcpContextInput(input);
        const record = await this.#context.resolve({
            ctxId: contextInput.ctxId,
            instance: this.#instanceName,
            principal: requestContext.principal,
            touch: true,
        });
        return { input: contextInput.input, record };
    }

}

export function isAppOnlyInteractionTool(toolName: string): boolean {
    return (
        toolName === "mcpapp_reconnect" ||
        toolName === "mcpapp_snapshot" ||
        toolName === "mcpapp_watch" ||
        toolName === "mcpapp_reentry" ||
        toolName === "mcpapp_action"
    );
}

function hasToolProvenance(provenance: ToolCallProvenance): boolean {
    return (
        provenance.purpose !== undefined || provenance.explanation !== undefined
    );
}

function contextEnvironment(
    record: ContextRecord,
    instance: string,
): ContextEnvironment | undefined {
    return record.environments.find(
        (environment) => environment.instance === instance,
    );
}

function appendWorkspaceAdvice(
    result: McpEndpointResult,
    comments: readonly string[],
): McpEndpointResult {
    if (comments.length === 0) return result;
    if (result instanceof McpNativeToolResult) {
        return new McpNativeToolResult({
            ...(result._meta === undefined ? {} : { _meta: result._meta }),
            content: result.content,
            isError: result.isError,
            structuredContent: appendStructuredComments(
                result.structuredContent,
                comments,
            ),
        });
    }
    return appendStructuredComments(result, comments);
}

function appendStructuredComments(
    value: JsonValue,
    comments: readonly string[],
): JsonValue {
    if (!isRecord(value)) return value;
    const existing = Array.isArray(value.comment)
        ? value.comment.filter(
              (entry): entry is string =>
                  typeof entry === "string" && entry.length > 0,
          )
        : [];
    return {
        ...value,
        comment: [...new Set([...existing, ...comments])],
    };
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
