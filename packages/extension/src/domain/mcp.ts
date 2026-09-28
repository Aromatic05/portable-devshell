import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration,
} from "../ExtensionApi.js";

export type McpToolActivity =
    | "execution"
    | "mutation"
    | "observation"
    | "wait";

export interface McpToolDeclaration extends ExtensionPointDeclaration {
    readonly activity?: McpToolActivity;
    readonly description: string;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly inputSchema: ExtensionJsonValue;
    readonly invoked?: string;
    readonly invoking?: string;
    readonly openWorldHint?: boolean;
    readonly outputSchema: ExtensionJsonValue;
    readonly readOnlyHint?: boolean;
    readonly title?: string;
}

export interface McpToolInvocationContext {
    readonly callId: string;
    readonly ctxId?: string;
    readonly instance: string;
    readonly requestId?: string;
    readonly signal: AbortSignal;
    readonly workspace?: string;
}

export interface McpToolTextContent {
    readonly text: string;
    readonly type: "text";
}

export interface McpToolResult {
    readonly content?: readonly McpToolTextContent[];
    readonly isError?: boolean;
    readonly structuredContent: ExtensionJsonValue;
}

export type McpToolBinding = (
    input: ExtensionJsonValue,
    context: McpToolInvocationContext,
) => Promise<McpToolResult> | McpToolResult;

/** Model-visible MCP tool contributed by one Extension generation. */
export const tools = defineExtensionPoint<McpToolDeclaration, McpToolBinding>(
    "mcp.tools",
);
