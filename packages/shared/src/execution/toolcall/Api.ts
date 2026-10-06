import type { InstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";
import type { ToolCallRecord } from "./Model.js";
import type {
    ToolCallContext,
    ToolCallHookContext,
    ToolCallHookValue,
    ToolCallPresentation,
    ToolDefinition,
} from "./Type.js";

/** Cross-package ingress for issuing tool calls through the global pipeline. */
export interface ToolCallApi {
    call(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
            presentation?: ToolCallPresentation,
        ) => Promise<JsonValue>,
        invocationInput?: (
            input: JsonValue,
            callId: string,
            finalValue: ToolCallHookValue,
        ) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording?: "caller" | "host",
    ): Promise<JsonValue>;
}

export type ToolCallIngressPort = Pick<ToolCallApi, "call">;
export type ToolCallHookDirection = "inbound" | "outbound";

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

export interface ToolCallPresentedResult {
    readonly type: "presented-tool-call-result";
    readonly presentation: ToolCallPresentation;
    readonly result: JsonValue;
}

export type ToolCallExecutor = (
    callId: string,
    input: JsonValue,
    value: Readonly<ToolCallHookValue>,
    signal?: AbortSignal,
    onProgress?: (progress: JsonValue) => void,
) => Promise<JsonValue | ToolCallPresentedResult> | JsonValue | ToolCallPresentedResult;

export type ToolNameHandle = () => ToolDefinition;

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

export interface ToolCallRegistration extends ToolCallHooks {
    registerToolName(toolName: string, handle: ToolNameHandle): () => void;
}

export interface ToolCallRuntime {
    readonly api: ToolCallApi;
    readonly hooks: ToolCallHooks;
    close(): void;
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
