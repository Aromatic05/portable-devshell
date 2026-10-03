import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration,
} from "../ExtensionCore.js";

export interface ToolCallExtensionDeclaration extends ExtensionPointDeclaration {
    readonly hook: string;
    readonly id: string;
}

export type ToolCallDirection = "inbound" | "outbound";
export type ToolCallKind = "call" | "error" | "progress" | "result";
export type ToolCallReviewDecision = "continue" | "reject";
export type ToolCallSource = "cli" | "extension" | "mcp" | "tui" | "web";
export type ToolCallStatus =
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "queueTimeout"
    | "cancelled";
export type ToolCallFailureStage = "postExecution" | "outboundHook";
export type ToolTermination = "exited" | "signaled" | "timeout";

export interface ToolCallContext {
    ctxId?: string;
    instance: string;
    operationId?: string;
    requestId?: string;
    source: ToolCallSource;
    workspace?: string;
}

export interface ToolCallValue {
    context: ToolCallContext;
    kind: ToolCallKind;
    payload: ExtensionJsonValue;
    toolName: string;
}

export interface ToolCallHistoryQuery {
    readonly after?: string;
    readonly before?: string;
    readonly callIds?: readonly string[];
    readonly ctxId?: string;
    readonly includeInput?: boolean;
    readonly includeOutput?: boolean;
    readonly limit?: number;
    readonly maxBytes?: number;
    readonly source?: ToolCallSource;
    readonly status?: ToolCallStatus;
    readonly toolName?: string;
    readonly workspace?: string;
}

export interface ToolCallHistoryRecord {
    readonly callId: string;
    readonly completedAt?: string;
    readonly ctxId?: string;
    readonly error?: string;
    readonly executionCompleted?: boolean;
    readonly exitCode?: number | null;
    readonly explanation?: string;
    readonly failureStage?: ToolCallFailureStage;
    readonly input?: ExtensionJsonValue;
    readonly inputSummary: string;
    readonly instance: string;
    readonly output?: ExtensionJsonValue;
    readonly purpose?: string;
    readonly requestId?: string;
    readonly source: ToolCallSource;
    readonly startedAt: string;
    readonly status: ToolCallStatus;
    readonly stderrBytes?: number;
    readonly stdoutBytes?: number;
    readonly termSignal?: number;
    readonly termination?: ToolTermination;
    readonly toolName: string;
    readonly workspace?: string;
}

/** Read-only access to retained ToolCall history owned by Control/Worker audit. */
export interface ToolCallHistoryCapability {
    listInstances(): Promise<readonly string[]>;
    read(
        instance: string,
        query?: ToolCallHistoryQuery,
    ): Promise<readonly ToolCallHistoryRecord[]>;
}

export interface ToolCallReviewInvocation {
    readonly callId: string;
    readonly direction: ToolCallDirection;
    readonly value: Readonly<ToolCallValue>;
}

export interface ToolCallReviewError {
    readonly code: string;
    readonly details?: ExtensionJsonValue;
}

export interface ToolCallReviewResult {
    readonly decision: ToolCallReviewDecision;
    readonly error?: ToolCallReviewError;
    readonly reason?: string;
}

export interface ToolCallReviewContext {
    readonly signal: AbortSignal;
    requestInterface(
        operation: string,
        input?: ExtensionJsonValue,
    ): Promise<ExtensionJsonValue | undefined>;
}

export type ToolCallReviewBinding = (
    input: ToolCallReviewInvocation,
    context: ToolCallReviewContext,
) => Promise<ToolCallReviewResult> | ToolCallReviewResult;

export interface ToolCallRewriteContext {
    readonly signal: AbortSignal;
    requestInterface(
        operation: string,
        input?: ExtensionJsonValue,
    ): Promise<ExtensionJsonValue | undefined>;
}

export interface ToolCallRewriteInvocation {
    readonly callId: string;
    readonly direction: ToolCallDirection;
    readonly value: ToolCallValue;
}

export type ToolCallRewriteBinding = (
    input: ToolCallRewriteInvocation,
    context: ToolCallRewriteContext,
) => Promise<ToolCallValue> | ToolCallValue;

export const review = defineExtensionPoint<
    ToolCallExtensionDeclaration,
    ToolCallReviewBinding
>("toolcall.review");

export const rewrite = defineExtensionPoint<
    ToolCallExtensionDeclaration,
    ToolCallRewriteBinding
>("toolcall.rewrite");
