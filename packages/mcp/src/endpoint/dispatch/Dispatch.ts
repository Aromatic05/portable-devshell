import type { ToolCallHookValue } from "@portable-devshell/shared";
import {
    type GoalActivityKind,
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
import type { McpInstanceGateway } from "../../instance/Gateway.js";
import { McpWorkspaceReentryArbiter } from "../../workspace/reentry/Arbiter.js";
import {
    throwIfMcpEndpointAborted,
    requireMcpEndpointGateway,
} from "../call/Boundary.js";
import {
    mcpLegacyToolTombstone,
    resolveMcpLegacyTool,
} from "../tool/Compatibility.js";
import type { McpEndpointCatalog } from "../tool/Catalog.js";
import { mcpToolActivity } from "../tool/Metadata.js";
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
export type { McpEndpointEnvironmentHandshake } from "../../instance/Gateway.js";

export interface McpEndpointDispatchOptions {
    catalog: McpEndpointCatalog;
    contextRegistry: ContextRegistryPort;
    contextSelector?: McpContextSelector;
    gateway?: McpInstanceGateway;
    instanceName: string;
    tmuxBlockSyncMs?: number;
    toolProvenance?: McpToolProvenanceRecorder;
    worker: McpEndpointWorkerPort;
}

interface McpAcceptedCall {
    value: ToolCallHookValue;
    executionEpoch?: number;
    goalActivity?: GoalActivityKind;
    workspaceAdvice: string[];
}

// Keep one product-visible synchronous handoff window across all MCP context modes.
const MCP_TMUX_BLOCK_SYNC_MS = 3 * 60_000;

export function mcpTmuxBlockSyncMsForContextMode(
    _mode: McpContextSelector["id"],
): number {
    return MCP_TMUX_BLOCK_SYNC_MS;
}

export class McpEndpointDispatch {
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: ContextRegistryPort;
    readonly #contextSelector: McpContextSelector;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #reentry: McpWorkspaceReentryArbiter;
    readonly #tmuxBlockSyncMs: number;
    readonly #toolProvenance?: McpToolProvenanceRecorder;
    readonly #worker: McpEndpointWorkerPort;
    readonly #workerHandler: McpEndpointHandlerTool;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#contextRegistry = options.contextRegistry;
        this.#contextSelector =
            options.contextSelector ?? createMcpContextSelector("explicit");
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#reentry = new McpWorkspaceReentryArbiter({
            contextRegistry: this.#contextRegistry,
            gateway: options.gateway,
            instanceName: options.instanceName,
        });
        this.#tmuxBlockSyncMs =
            options.tmuxBlockSyncMs ??
            mcpTmuxBlockSyncMsForContextMode(this.#contextSelector.id);
        this.#toolProvenance = options.toolProvenance;
        this.#worker = options.worker;
        this.#workerHandler = new McpEndpointHandlerTool({
            gateway: options.gateway,
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
        try {
            return appendWorkspaceAdvice(
                await this.#workerHandler.call(
                    toolName,
                    input,
                    context,
                    snapshot.instanceRoutingEnabled,
                    signal,
                    undefined,
                    async (rewrittenInput, callId, value) => {
                        await prepareCall(callId, value);
                        return rewrittenInput;
                    },
                ),
                accepted?.workspaceAdvice ?? [],
            );
        } finally {
            const finalContext = accepted?.value.context;
            if (finalContext?.ctxId !== undefined && signal?.aborted !== true) {
                await this.#reentry.observeExecutionActivity(finalContext.ctxId, finalContext.instance);
            }
            if (finalContext?.ctxId !== undefined && accepted?.goalActivity !== undefined) {
                await this.#gateway?.touchGoal?.(
                    finalContext.instance, finalContext.ctxId, accepted.goalActivity,
                ).catch(() => undefined);
            }
        }
    }

    async #prepareCall(
        callId: string,
        value: ToolCallHookValue,
        requestContext: McpEndpointCallContext,
        provenance: ToolCallProvenance,
    ): Promise<McpAcceptedCall> {
        const { instance, ctxId } = value.context;
        const gateway = requireMcpEndpointGateway(this.#gateway, this.#instanceName);
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
        const executionEpoch = await this.#reentry.observeExecutionStart(record.ctxId, instance);
        const definition = this.#catalog.getTool(value.toolName, instance);
        const goalActivity = value.toolName === "workspace_goal" ? undefined
            : workspaceGoalActivity(value.toolName, value.payload, this.#tmuxBlockSyncMs, definition?._meta);
        if (goalActivity !== undefined) {
            await this.#contextRegistry.reentry.observeAutomaticReentryActivity(record.ctxId, instance, goalActivity).catch(() => undefined);
            await gateway.touchGoal?.(instance, record.ctxId, goalActivity);
        }
        if (hasToolProvenance(provenance) && this.#toolProvenance !== undefined) {
            await this.#toolProvenance.record({ callId, ...provenance, instance }).catch(() => undefined);
        }
        return { value, executionEpoch, goalActivity, workspaceAdvice };
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
        if (this.#gateway !== undefined) {
            await this.#gateway.appendMcpToolCalled(
                instance,
                toolName,
                context,
            );
        }
    }

}

function isAppOnlyInteractionTool(toolName: string): boolean {
    return (
        toolName === "workspace_reconnect" ||
        toolName === "workspace_snapshot" ||
        toolName === "workspace_watch" ||
        toolName === "workspace_reentry" ||
        toolName === "workspace_action"
    );
}

function isPassiveWorkspaceRead(toolName: string): boolean {
    return (
        toolName === "workspace_reconnect" ||
        toolName === "workspace_snapshot" ||
        toolName === "workspace_watch"
    );
}

const OBSERVATION_TOOLS = new Set([
    "artifact_share",
    "artifact_viewImage",
    "file_glob",
    "file_grep",
    "file_read",
    "instance_list",
    "instance_status",
    "tmux_inspect",
    "todo_read",
    "workspace_open",
]);

const MUTATION_TOOLS = new Set(["file_edit", "todo_write"]);

function workspaceGoalActivity(
    toolName: string,
    input: JsonValue,
    tmuxBlockSyncMs: number,
    meta?: JsonValue,
): GoalActivityKind {
    const declared = mcpToolActivity(meta);
    if (declared !== undefined) return declared;
    if (toolName === "workspace_ask") return "wait";
    if (toolName === "tmux_run")
        return readTmuxBlock(input) ? "wait" : "execution";
    if (toolName === "tmux_read")
        return readTmuxReadTimeMs(input) >= tmuxBlockSyncMs
            ? "wait"
            : "observation";
    if (
        toolName === "tmux_manage" &&
        isRecord(input) &&
        input.command === "list"
    )
        return "observation";
    if (OBSERVATION_TOOLS.has(toolName)) return "observation";
    if (MUTATION_TOOLS.has(toolName)) return "mutation";
    return "execution";
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
