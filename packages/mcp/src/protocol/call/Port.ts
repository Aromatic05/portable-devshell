export interface McpEndpointCallContext {
    principal: string;
    requestMeta?: Record<string, unknown>;
    requestId?: string;
}
