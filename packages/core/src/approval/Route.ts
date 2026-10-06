// Approval control route. Legacy `list` remains an array for the current
// clients; the new projection uses `snapshot`, which samples the instance cursor
// before the authoritative read and then subscribes from `lastSeq + 1`.
// Changes racing with the read may be observed twice, but cannot be missed.

import type {
    ApprovalEvent,
    ApprovalDecisionBy,
    ControlPortContext,
    ControlPortDefinition,
    InstanceEventRecord,
    JsonValue,
    MessageStream,
} from "@portable-devshell/shared";
import { isApprovalEventType } from "@portable-devshell/shared";

import { routeModule } from "@portable-devshell/shared";
import type { ApprovalApi } from "./Api.js";
import type { InstanceEventSource } from "../instance/Api.js";

import {
    readApprovalDecision,
    readApprovalId,
    readApprovalListOptions,
    readApprovalSubscriptionFromSeq,
} from "./Request.js";

interface ApprovalRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: Pick<InstanceEventSource, "subscribe">,
        fromSeq: number,
        projectEvent?: (
            event: InstanceEventRecord,
        ) => ApprovalEvent | undefined,
    ): Promise<void>;
}

interface ApprovalRouteInstancePort {
    approval: Pick<
        ApprovalApi,
        | "decideApproval"
        | "getApproval"
        | "listApprovals"
        | "listPendingApprovals"
    >;
    events: InstanceEventSource;
    name: string;
}






export function createApprovalRouteModule(
    instance: ApprovalRouteInstancePort,
    subscriptions: ApprovalRouteSubscriptionPort,
): ControlPortDefinition {
    return routeModule(
        "approval",
        {
            list: async (request) => {
                const { pendingOnly } = readApprovalListOptions(
                    request.payload,
                );
                return (await (pendingOnly
                    ? instance.approval.listPendingApprovals()
                    : instance.approval.listApprovals())) as unknown as JsonValue;
            },
            snapshot: async (request) => {
                const { pendingOnly } = readApprovalListOptions(
                    request.payload,
                );
                const lastSeq = instance.events.cursor();
                const approvals = await (pendingOnly
                    ? instance.approval.listPendingApprovals()
                    : instance.approval.listApprovals());
                return { approvals, lastSeq } as unknown as JsonValue;
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
        },
        {
            subscribe: async (stream, request, context) =>
                await subscriptions.subscribe(
                    stream,
                    context,
                    instance.name,
                    instance.events,
                    readApprovalSubscriptionFromSeq(request.payload),
                    (event) =>
                        isApprovalEventType(event.type)
                            ? (event as ApprovalEvent)
                            : undefined,
                ),
        },
    );
}
