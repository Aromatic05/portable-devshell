import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import { createError, errorCodes, type JsonValue, type PrefixRouteContext, type PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../route/ControlRouteFactory.js";
import { readMcpApprovalDecision, readMcpApprovalId } from "./McpRouteInput.js";

export interface McpRouteModuleOptions {
    approvals(): McpOAuthApprovalService | undefined;
    status(): JsonValue;
}

export function createMcpRouteModule(options: McpRouteModuleOptions): PrefixRouteModuleDefinition {
    const approvals = () => requirePort(options.approvals(), "MCP OAuth approvals are not available.");
    return routeModule("mcp", {
        status: () => options.status(),
        listApprovals: async () => await approvals().list() as never,
        decideApproval: async (request, context) => await approvals().decide(
            readMcpApprovalId(request.payload),
            readMcpApprovalDecision(request.payload),
            readApprovalPeer(context)
        ) as never
    });
}

function readApprovalPeer(context: PrefixRouteContext): "cli" | "tui" | "web" {
    if (context.peer !== "agent") return context.peer;
    throw createError({
        code: errorCodes.controlClientIdentityInvalid,
        message: "Agent peers cannot decide MCP approvals.",
        retryable: false
    });
}
