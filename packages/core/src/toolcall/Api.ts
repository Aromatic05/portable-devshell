import type {
    InstanceName,
    JsonValue,
    Endpoint,
    ControlPortContext,
    InstanceEventRecord,
    ToolCallPresentation,
    ToolCallQuery,
    ToolCallRecord,
    ToolCallHookContext,
    ToolCallHookKind,
    ToolCallHookValue,
    ToolDefinition,
    ToolEvent,
    ToolCallApi,
    MessageStream,
    STREAM_GAP_CODE,
} from "@portable-devshell/shared";
import type {
    AuditApi,
    AuditToolCallFailureSummary,
    InstanceLogEntry,
    LogQuery,
} from "../audit/Public.js";

export type { ToolCallApi };
export type ToolCallIngressPort = Pick<ToolCallApi, "call">;

export type ToolCallHookDirection = "inbound" | "outbound";

export type { ToolCallHookContext, ToolCallHookKind, ToolCallHookValue };

export interface ToolCallReviewInput {
    readonly callId: string;
    readonly direction: ToolCallHookDirection;
    readonly value: Readonly<ToolCallHookValue>;
}

export interface ToolCallReviewError {
    readonly code: string;
    readonly details?: JsonValue;
}

export interface ToolCallReviewResult {
    readonly decision: "continue" | "reject";
    readonly error?: ToolCallReviewError;
    readonly reason?: string;
}

export interface ToolCallRewriteInput {
    readonly callId: string;
    readonly direction: ToolCallHookDirection;
    readonly value: ToolCallHookValue;
}

export interface ToolCallHookSequenceApi {
    review(input: ToolCallReviewInput): Promise<ToolCallReviewResult>;
    rewrite(input: ToolCallRewriteInput): Promise<ToolCallHookValue>;
}

export type ToolCallExecutor = (
    callId: string,
    input: JsonValue,
    value: Readonly<ToolCallHookValue>,
    signal?: AbortSignal,
    onProgress?: (progress: JsonValue) => void,
) =>
    | Promise<JsonValue | ToolCallPresentedResult>
    | JsonValue
    | ToolCallPresentedResult;

export interface ToolCallPresentedResult {
    readonly type: "presented-tool-call-result";
    readonly presentation: ToolCallPresentation;
    readonly result: JsonValue;
}

export interface ToolCallDispatchRequest {
    readonly callId: string;
    readonly execute?: ToolCallExecutor;
    readonly hooks: ToolCallHookSequenceApi;
    readonly invocationInput?: (
        input: JsonValue,
        callId: string,
        finalValue: ToolCallHookValue,
    ) => Promise<JsonValue> | JsonValue;
    readonly onProgress?: (progress: JsonValue) => void;
    readonly recording: "caller" | "host";
    readonly signal?: AbortSignal;
    readonly transformResult?: (
        result: JsonValue,
        callId: string,
        presentation?: ToolCallPresentation,
    ) => Promise<JsonValue>;
    readonly value: ToolCallHookValue;
}

export interface ToolCallTarget {
    dispatch(request: ToolCallDispatchRequest): Promise<JsonValue>;
}

export type ToolCallTargetResolver = (instance: InstanceName) => ToolCallTarget;

export interface ToolCallHookRuntime {
    readonly recording: "caller" | "host";
    readonly signal: AbortSignal;
}

export interface ToolCallReviewHook {
    readonly hook: string;
    readonly id: string;
    readonly owner?: string;
    readonly review: (
        input: ToolCallReviewInput,
        runtime: ToolCallHookRuntime,
    ) => Promise<ToolCallReviewResult> | ToolCallReviewResult;
}

export interface ToolCallRewriteHook {
    readonly hook: string;
    readonly id: string;
    readonly owner?: string;
    readonly rewrite: (
        input: ToolCallRewriteInput,
        runtime: ToolCallHookRuntime,
    ) => Promise<ToolCallHookValue> | ToolCallHookValue;
}

export interface ToolCallHookContribution {
    readonly reviews?: readonly ToolCallReviewHook[];
    readonly rewrites?: readonly ToolCallRewriteHook[];
    release(): void;
}

export type ToolCallHookContributor = (
    context: ToolCallHookContext,
    runtime: ToolCallHookRuntime,
) => Promise<ToolCallHookContribution> | ToolCallHookContribution;

export interface ToolCallHooks {
    registerContributor(contributor: ToolCallHookContributor): () => void;
    registerExecute(toolName: string, execute: ToolCallExecutor): () => void;
    registerReview(review: ToolCallReviewHook): () => void;
}

export interface ToolCallRuntime {
    readonly api: import("@portable-devshell/shared").ToolCallApi;
    readonly hooks: ToolCallHooks;
    close(): void;
}

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
        context?: import("@portable-devshell/shared").ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    refreshTools(): Promise<ToolDefinition[]>;
    close(): Promise<void>;
}

export interface ToolRouteEventPort {
    subscribe(fromSeq?: number):
        | { kind: "events"; events: InstanceEventRecord[]; lastSeq: number }
        | { kind: "gap"; code: typeof STREAM_GAP_CODE; fromSeq: number; lastSeq: number; nextSeq: number };
}

export interface ToolRouteInstancePort {
    name?: string;
    worker: {
        readWorkerTools(): Promise<readonly ToolDefinition[]>;
        prepareWorkspace(workspace: string, connectionId: string): Promise<{ workspace: string }>;
        readToolCalls(query: ToolCallQuery): Promise<ToolCallRecord[]>;
        releaseToolSession(connectionId: string): Promise<void>;
    } & Partial<ToolRouteEventPort>;
}

export interface ToolRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: ToolRouteEventPort,
        fromSeq: number,
        projectEvent?: (event: InstanceEventRecord) => ToolEvent | undefined,
    ): Promise<void>;
}

export interface ToolCallProvenanceRecord {
    readonly callId: string;
    readonly explanation?: string;
    readonly instance: string;
    readonly purpose?: string;
}

export interface ToolCallProvenanceApi {
    record(record: ToolCallProvenanceRecord): Promise<void>;
    decorate(
        instance: string,
        records: readonly ToolCallRecord[],
    ): Promise<ToolCallRecord[]>;
    warmup(): Promise<void>;
    flush(): Promise<void>;
}

export interface ToolCallProvenanceOptions {
    coldMaxBytes?: number;
    hotMaxBytes?: number;
    now?: () => number;
    retentionDays?: number;
}
