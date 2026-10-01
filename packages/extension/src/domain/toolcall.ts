import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration,
} from "../ExtensionApi.js";

export interface ToolCallExtensionDeclaration extends ExtensionPointDeclaration {
    readonly hook: string;
    readonly id: string;
}

export type ToolCallDirection = "inbound" | "outbound";
export type ToolCallKind = "call" | "error" | "progress" | "result";
export type ToolCallReviewDecision = "continue" | "reject";
export type ToolCallSource = "cli" | "extension" | "mcp" | "tui" | "web";

export interface ToolCallContext {
    ctxId?: string;
    instance: string;
    extensionId?: string;
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
