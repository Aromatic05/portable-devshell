export interface McpExtensionResourceContent {
    readonly _meta?: Record<string, unknown>;
    readonly text: string;
}

export interface McpExtensionResource {
    readonly aliases?: readonly string[];
    readonly app?: boolean;
    readonly mimeType: string;
    readonly name: string;
    readonly uri: string;
    read(
        requestedUri: string,
    ): Promise<McpExtensionResourceContent> | McpExtensionResourceContent;
}

export interface McpExtensionPresentation {
    readonly bootstrap?: "environment";
    readonly resourceUri: string;
}

/**
 * One atomic MCP-facing contribution. Additional facets such as tools/live
 * can be added here while preserving one generation-owned contribution.
 */
export interface McpExtension {
    readonly id: string;
    readonly presentation?: McpExtensionPresentation;
    readonly resources?: readonly McpExtensionResource[];
}

export interface McpExtensionResourceDescriptor {
    readonly mimeType: string;
    readonly name: string;
    readonly uri: string;
}

export interface McpExtensionResourceReadResult
    extends McpExtensionResourceDescriptor,
        McpExtensionResourceContent {}
