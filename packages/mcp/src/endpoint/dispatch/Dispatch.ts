import {
    bootstrapToolNamespace,
    toolNamespace,
    type ToolCallHookValue,
    type JsonValue,
    type McpContextEnvironment,
    type McpContextRecord,
    type ToolCallContext,
    type ToolCallProvenance,
} from "@portable-devshell/shared";

import type { ContextRegistryPort } from "@portable-devshell/shared";
import {
    createMcpContextSelector,
    readMcpContextInput,
    type McpContextSelector,
} from "../../context/Selector.js";
import {
    presentMcpEndpointResult,
    throwIfMcpEndpointAborted,
} from "../call/Boundary.js";
import {
    mcpLegacyToolTombstone,
    resolveMcpLegacyTool,
} from "../tool/Compatibility.js";
import type { McpEndpointCatalog } from "../tool/Catalog.js";
import {
    readMcpProvenanceInput,
    readMcpRoutedInput,
} from "../tool/Input.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "../call/Port.js";
import { McpNativeToolResult, type McpEndpointResult } from "../call/Boundary.js";
import type { McpToolProvenanceRecorder } from "../tool/Provenance.js";
import { McpEndpointHandlerTool } from "../tool/Handler.js";
import {
    assertMcpEndpointReady,
    mcpEndpointToolNotExposed,
} from "../call/Boundary.js";

export type {
    McpEndpointCallContext,
    McpEndpointWorkerPort,
} from "../call/Port.js";

export interface McpEndpointDispatchOptions {
    catalog: McpEndpointCatalog;
    contextRegistry: ContextRegistryPort;
    contextSelector?: McpContextSelector;
    instanceName: string;
    toolProvenance?: McpToolProvenanceRecorder;
    worker: McpEndpointWorkerPort;
}

interface McpAcceptedCall {
    value: ToolCallHookValue;
    workspaceAdvice: string[];
}

export class McpEndpointDispatch {
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: ContextRegistryPort;
    readonly #contextSelector: McpContextSelector;
    readonly #instanceName: string;
    readonly #toolProvenance?: McpToolProvenanceRecorder;
    readonly #worker: McpEndpointWorkerPort;
    readonly #workerHandler: McpEndpointHandlerTool;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#contextRegistry = options.contextRegistry;
        this.#contextSelector =
            options.contextSelector ?? createMcpContextSelector("explicit");
        this.#instanceName = options.instanceName;
        this.#toolProvenance = options.toolProvenance;
        this.#worker = options.worker;
        this.#workerHandler = new McpEndpointHandlerTool({
            instanceName: options.instanceName,
        });
    }

    assertReady(
        worker: Pick<McpEndpointWorkerPort, "snapshot"> = this.#worker,
        instanceName: string = this.#instanceName,
    ): void {
        assertMcpEndpointReady(worker, instanceName);
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        throwIfMcpEndpointAborted(signal);
        const compatibility = resolveMcpLegacyTool(toolName);
        if (compatibility?.kind === "tombstone") {
            return mcpLegacyToolTombstone(toolName, compatibility);
        }
        if (
            compatibility?.kind === "alias" ||
            compatibility?.kind === "workspace-app-v0615"
        ) {
            toolName = compatibility.replacement;
        }
        const snapshot = this.#catalog.snapshot();
        const selected = snapshot.entries.find(
            (entry) => entry.definition.name === toolName,
        );

        if (selected === undefined) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }

        if (toolNamespace(toolName) === bootstrapToolNamespace) {
            return await this.#workerHandler.call(
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
                snapshot.instanceRoutingEnabled,
                signal,
            );
        }

        const appOnlyInteraction = isAppOnlyInteractionTool(toolName);
        const provenanceInput = readMcpProvenanceInput(input);
        input = provenanceInput.input;
        const touchContext = !isPassiveWorkspaceRead(toolName);
        const resolvedContext = appOnlyInteraction
            ? await this.#resolveAppOnlyContext(
                  input,
                  requestContext,
                  !isPassiveWorkspaceRead(toolName),
              )
            : await this.#contextSelector.resolve(
                  this.#contextRegistry,
                  input,
                  requestContext,
                  this.#instanceName,
                  {
                      allowExpired:
                          touchContext &&
                          !this.#contextSelector.requiresExplicitContextId,
                      touch: false,
                  },
              );
        input = resolvedContext.input;
        const routed =
            selected.scope !== "*"
                ? readMcpRoutedInput(
                      input,
                      snapshot.instanceRoutingEnabled,
                      this.#instanceName,
                  )
                : { input, instance: this.#instanceName };
        const context = this.#createToolContext(
            resolvedContext.record,
            requestContext,
            routed.instance,
            signal,
        );
        let accepted: McpAcceptedCall | undefined;
        let presentation: import("@portable-devshell/shared").ToolCallPresentation | undefined;
        const prepareCall = async (
            callId: string,
            finalValue: ToolCallHookValue,
        ): Promise<McpAcceptedCall> => {
            accepted = await this.#prepareCall(
                callId,
                finalValue,
                requestContext,
                provenanceInput.provenance,
            );
            return accepted;
        };
        const result = await this.#workerHandler.call(
                toolName,
                input,
                context,
                snapshot.instanceRoutingEnabled,
                signal,
                async (structured, _callId, nextPresentation) => {
                    presentation = nextPresentation;
                    return structured;
                },
                async (rewrittenInput, callId, value) => {
                    await prepareCall(callId, value);
                    return rewrittenInput;
                },
            );
        return appendWorkspaceAdvice(
            presentMcpEndpointResult(result, presentation),
            accepted?.workspaceAdvice ?? [],
        );
    }

    async #prepareCall(
        callId: string,
        value: ToolCallHookValue,
        requestContext: McpEndpointCallContext,
        provenance: ToolCallProvenance,
    ): Promise<McpAcceptedCall> {
        const { instance, ctxId } = value.context;
        const touchContext = !isPassiveWorkspaceRead(value.toolName);
        let record = await this.#contextRegistry.lookup(ctxId!, {
            principal: requestContext.principal,
        });
        if (touchContext) {
            record = record.status === "expired"
                ? await this.#contextRegistry.renewForPrincipal(record.ctxId, { principal: requestContext.principal })
                : await this.#contextRegistry.validateAndTouch(record.ctxId, { principal: requestContext.principal });
        } else {
            record = await this.#contextRegistry.validate(record.ctxId, { principal: requestContext.principal });
        }
        await this.#contextRegistry.assertInstanceAvailable(record.ctxId, instance);
        const workspaceAdvice: string[] = [];
        await this.#appendMcpToolCalled(instance, value.toolName, value.context);
        if (hasToolProvenance(provenance) && this.#toolProvenance !== undefined) {
            await this.#toolProvenance.record({ callId, ...provenance, instance }).catch(() => undefined);
        }
        return { value, workspaceAdvice };
    }


    #createToolContext(
        record: McpContextRecord,
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
        touch: boolean,
    ): Promise<{ input: JsonValue; record: McpContextRecord }> {
        const contextInput = readMcpContextInput(input);
        const record = touch
            ? await this.#contextRegistry.validateAndTouch(contextInput.ctxId, {
                  principal: requestContext.principal,
              })
            : await this.#contextRegistry.validate(contextInput.ctxId, {
                  principal: requestContext.principal,
              });
        return { input: contextInput.input, record };
    }

    async #appendMcpToolCalled(
        instance: string,
        toolName: string,
        context: { requestId?: string; ctxId?: string },
    ): Promise<void> {
        if (instance === this.#instanceName) {
            await this.#worker.appendMcpToolCalled(toolName, context);
            return;
        }
    }

}

function isAppOnlyInteractionTool(toolName: string): boolean {
    return (
        toolName === "mcpapp_reconnect" ||
        toolName === "mcpapp_snapshot" ||
        toolName === "mcpapp_watch" ||
        toolName === "mcpapp_reentry" ||
        toolName === "mcpapp_action"
    );
}

function isPassiveWorkspaceRead(toolName: string): boolean {
    return (
        toolName === "mcpapp_reconnect" ||
        toolName === "mcpapp_snapshot" ||
        toolName === "mcpapp_watch"
    );
}

function hasToolProvenance(provenance: ToolCallProvenance): boolean {
    return (
        provenance.purpose !== undefined || provenance.explanation !== undefined
    );
}

function contextEnvironment(
    record: McpContextRecord,
    instance: string,
): McpContextEnvironment | undefined {
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
