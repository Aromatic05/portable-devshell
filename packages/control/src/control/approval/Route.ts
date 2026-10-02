import type { ApprovalDecisionBy, ControlPortDefinition, JsonValue } from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../instance/Descriptor.js";
import { routeModule } from "../../server/Route.js";
import {
    readApprovalDecision,
    readApprovalId,
    readApprovalListOptions,
} from "./Input.js";

export type ApprovalRouteInstancePort = Pick<InstanceDescriptor, "approval">;

export function createApprovalRouteModule(
    instance: ApprovalRouteInstancePort,
): ControlPortDefinition {
    return routeModule("approval", {
        list: async (request) => {
            const { pendingOnly } = readApprovalListOptions(request.payload);
            return (await (pendingOnly
                ? instance.approval.listPendingApprovals()
                : instance.approval.listApprovals())) as unknown as JsonValue;
        },
        get: async (request) =>
            (await instance.approval.getApproval(
                readApprovalId(request.payload, "approval.get"),
            )) as unknown as JsonValue,
        decide: async (request, context) =>
            (await instance.approval.decideApproval(
                readApprovalId(request.payload, "approval.decide"),
                {
                    ...readApprovalDecision(request.payload),
                    decidedBy: context.peer as ApprovalDecisionBy,
                },
            )) as unknown as JsonValue,
    });
}
