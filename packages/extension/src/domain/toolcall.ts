import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration,
} from "../ExtensionApi.js";

export interface ToolCallExtensionDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
}

export type ToolCallDirection = "inbound" | "outbound";
export type ToolCallPayloadKind = "call" | "error" | "progress" | "result";
export type ToolCallReviewDecision = "accept" | "approve" | "reject";
export type ToolCallSource = "cli" | "extension" | "mcp" | "tui" | "web";

export interface ToolCallContext {
    readonly ctxId?: string;
    readonly instance: string;
    readonly extensionId?: string;
    readonly operationId?: string;
    readonly requestId?: string;
    readonly source: ToolCallSource;
    readonly workspace?: string;
}

export interface ToolCallReviewInvocation {
    readonly context: ToolCallContext;
    readonly direction: ToolCallDirection;
    readonly kind: ToolCallPayloadKind;
    readonly payload: ExtensionJsonValue;
    readonly signal: AbortSignal;
    readonly toolName: string;
}

export interface ToolCallReviewError {
    readonly code: string;
    readonly details?: ExtensionJsonValue;
}

export interface ToolCallReviewResult {
    /**
     * Admission decision for inbound calls. Outbound review is feedback-only;
     * its decision does not change an already-established ToolCall outcome.
     */
    readonly decision: ToolCallReviewDecision;
    readonly error?: ToolCallReviewError;
    readonly feedback?: readonly string[];
    readonly reason?: string;
}

/** Host interfaces scoped to exactly one toolcall.review invocation. */
export interface ToolCallReviewContext {
    requestInterface(
        operation: string,
        input?: ExtensionJsonValue,
    ): Promise<ExtensionJsonValue | undefined>;
}

export type ToolCallReviewBinding = (
    input: ToolCallReviewInvocation,
    context: ToolCallReviewContext,
) => Promise<ToolCallReviewResult> | ToolCallReviewResult;

/** Host interfaces scoped to exactly one toolcall.rewrite invocation. */
export interface ToolCallRewriteContext {
    requestInterface(
        operation: string,
        input?: ExtensionJsonValue,
    ): Promise<ExtensionJsonValue | undefined>;
}

export interface ToolCallRewriteInvocation {
    readonly context: ToolCallContext;
    readonly direction: ToolCallDirection;
    readonly kind: ToolCallPayloadKind;
    readonly path: readonly (number | string)[];
    readonly signal: AbortSignal;
    readonly text: string;
    readonly toolName: string;
}

export type ToolCallRewriteBinding = (
    input: ToolCallRewriteInvocation,
    context: ToolCallRewriteContext,
) => Promise<string> | string;

export const review = defineExtensionPoint<
    ToolCallExtensionDeclaration,
    ToolCallReviewBinding
>("toolcall.review");

export const rewrite = defineExtensionPoint<
    ToolCallExtensionDeclaration,
    ToolCallRewriteBinding
>("toolcall.rewrite");
