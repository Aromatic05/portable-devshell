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

export interface ToolCallReviewResult {
    readonly decision: ToolCallReviewDecision;
    readonly reason?: string;
}

export type ToolCallReviewBinding = (
    input: ToolCallReviewInvocation,
) => Promise<ToolCallReviewResult> | ToolCallReviewResult;

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
) => Promise<string> | string;

export const review = defineExtensionPoint<
    ToolCallExtensionDeclaration,
    ToolCallReviewBinding
>("toolcall.review");

export const rewrite = defineExtensionPoint<
    ToolCallExtensionDeclaration,
    ToolCallRewriteBinding
>("toolcall.rewrite");
