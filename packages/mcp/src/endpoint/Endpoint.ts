// Test-only compatibility for the pre-domain endpoint constructor.
import type { ContextTransport, JsonValue } from '@portable-devshell/shared';
import { McpEndpoint as ProtocolEndpoint, type McpEndpointOptions as ProtocolOptions } from '../protocol/Endpoint.js';
import { McpAppCall } from '../mcpapp/Call.js';
import { McpAppActionStore } from '../mcpapp/ActionStore.js';
import type { createMcpAppViewModel } from '../mcpapp/ViewModel.js';
import type { McpEndpointCallContext } from '../protocol/Api.js';

export interface McpEndpointOptions extends ProtocolOptions {
    mcpAppBootstrap?: (result: JsonValue, request: McpEndpointCallContext) => Promise<{
        ctxId: string; token: string; liveBaseUrl?: string;
    } | undefined>;
    mcpAppActions?: McpAppActionStore;
    mcpAppView?: ReturnType<typeof createMcpAppViewModel>;
}

export class McpEndpoint extends ProtocolEndpoint {
    constructor(options: McpEndpointOptions) {
        const hasApp = options.mcpAppActions !== undefined || options.mcpAppBootstrap !== undefined;
        super({
            ...options,
            ...(hasApp ? { toolAdapter: (dispatch) => new McpAppCall({
                actions: options.mcpAppActions ?? new McpAppActionStore(),
                context: options.context,
                dispatch,
                instance: options.instanceName,
                ...(options.mcpAppView === undefined ? {} : { view: options.mcpAppView }),
                ...(options.mcpAppBootstrap === undefined ? {} : { bootstrap: options.mcpAppBootstrap }),
            }) } : {}),
        });
    }
}
export { McpNativeToolResult, type McpEndpointResult } from '../protocol/Endpoint.js';
