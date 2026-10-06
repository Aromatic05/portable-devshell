import type {
    Endpoint,
    InstanceName,
    JsonValue,
    ToolCallContext,
    ToolCallQuery,
    ToolCallRecord,
    ToolCallTarget,
    ToolDefinition,
    ToolEvent,
} from "@portable-devshell/shared";
import type {
    AuditApi,
    AuditToolCallFailureSummary,
    InstanceLogEntry,
    LogQuery,
} from "../audit/Api.js";

export type {
    ToolCallApi,
    ToolCallDispatchRequest,
    ToolCallExecutor,
    ToolCallHookContext,
    ToolCallHookContribution,
    ToolCallHookContributor,
    ToolCallHookDirection,
    ToolCallHookKind,
    ToolCallHookRuntime,
    ToolCallHookSequenceApi,
    ToolCallHooks,
    ToolCallHookValue,
    ToolCallIngressPort,
    ToolCallPresentedResult,
    ToolCallProvenanceApi,
    ToolCallProvenanceOptions,
    ToolCallProvenanceRecord,
    ToolCallRegistration,
    ToolCallReviewError,
    ToolCallReviewHook,
    ToolCallReviewInput,
    ToolCallReviewResult,
    ToolCallRewriteHook,
    ToolCallRewriteInput,
    ToolCallRuntime,
    ToolCallTarget,
    ToolCallTargetResolver,
    ToolNameHandle,
} from "@portable-devshell/shared";

export interface ToolCallExecutionRuntimeOptions {
    appendEvent(
        type: ToolEvent["type"] | "log.appended",
        data?: JsonValue,
    ): Promise<unknown>;
    assertReady(): void;
    audit: AuditApi;
    endpoint: Endpoint;
    instanceName: InstanceName;
    readTools(): Promise<readonly ToolDefinition[]>;
}

export interface ToolCallExecutionRuntime {
    target(): ToolCallTarget;
    listTools(): ToolDefinition[];
    readToolCalls(query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    readLogs(query?: LogQuery): Promise<InstanceLogEntry[]>;
    hasActiveToolCalls(ctxId: string, excludeCallId?: string): boolean;
    readToolCallFailureSummary(
        sinceMs: number,
        untilMs: number,
    ): Promise<AuditToolCallFailureSummary>;
    invokeInternal(
        toolName: string,
        input: JsonValue,
        context?: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    refreshTools(): Promise<ToolDefinition[]>;
    close(): Promise<void>;
}
