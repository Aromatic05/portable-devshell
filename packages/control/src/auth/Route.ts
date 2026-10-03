import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import type {
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../server/Route.js";
import { readMcpApprovalDecision, readMcpApprovalId } from "./Input.js";

export interface AuthRouteModuleOptions {
    approvals(): McpOAuthApprovalService | undefined;
    status(): JsonValue;
}

export function createAuthRouteModule(
    options: AuthRouteModuleOptions,
): ControlPortDefinition {
    const approvals = () =>
        requirePort(
            options.approvals(),
            "MCP OAuth approvals are not available.",
        );
    return routeModule("auth", {
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
