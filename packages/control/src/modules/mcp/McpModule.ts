import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import type { JsonValue, PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../common/RouteModule.js";
import { readMcpApprovalDecision, readMcpApprovalId } from "./McpInput.js";

export interface McpModuleOptions {
    approvals(): McpOAuthApprovalService | undefined;
    status(): JsonValue;
}

export function createMcpModule(options: McpModuleOptions): PrefixRouteModuleDefinition {
    const approvals = () => requirePort(options.approvals(), "MCP OAuth approvals are not available.");
    return routeModule("mcp", {
        status: () => options.status(),
        listApprovals: async () => await approvals().list() as never,
        decideApproval: async (request, context) => await approvals().decide(
            readMcpApprovalId(request.payload),
            readMcpApprovalDecision(request.payload),
            context.peer
        ) as never
    });
}
