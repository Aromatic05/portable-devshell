import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import type {
    JsonValue,
    PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../../server/Route.js";
import { readMcpApprovalDecision, readMcpApprovalId } from "./Input.js";

export interface McpRouteModuleOptions {
    approvals(): McpOAuthApprovalService | undefined;
    status(): JsonValue;
}

export function createMcpRouteModule(
    options: McpRouteModuleOptions,
): PrefixRouteModuleDefinition {
    const approvals = () =>
        requirePort(
            options.approvals(),
            "MCP OAuth approvals are not available.",
        );
    return routeModule("mcp", {
        status: () => options.status(),
        listApprovals: async () => (await approvals().list()) as never,
        decideApproval: async (request, context) =>
            (await approvals().decide(
                readMcpApprovalId(request.payload),
                readMcpApprovalDecision(request.payload),
                context.peer,
            )) as never,
    });
}
