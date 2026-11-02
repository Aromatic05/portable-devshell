// Approval reads and decisions use the instance approval port. The dedicated
// event stream resumes from the cursor carried by the authoritative snapshot.

import {
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type {
    ApprovalEvent,
    ApprovalDecisionOptions,
    ApprovalDecisionValue,
    ApprovalListResult,
    ApprovalRequest,
} from "./Model.js";

export interface ApprovalTransport {
    decide(
        approvalId: string,
        decision: ApprovalDecisionValue,
        options?: ApprovalDecisionOptions,
        signal?: AbortSignal,
    ): Promise<ApprovalRequest>;
    get(approvalId: string): Promise<ApprovalRequest>;
    list(options?: { pendingOnly?: boolean }): Promise<ApprovalRequest[]>;
    snapshot(options?: { pendingOnly?: boolean }, signal?: AbortSignal): Promise<ApprovalListResult>;
    subscribe(fromSeq: number): Promise<InstanceEventStreamPort<ApprovalEvent>>;
}

export function createApprovalTransport(
    endpoint: Endpoint,
    instance: string,
): ApprovalTransport {
    const instanceName = asInstanceName(instance);
    const port = createPortClient(endpoint, instanceName, "approval");
    return {
        decide: (approvalId, decision, options = {}, signal) =>
            port.request<ApprovalRequest>("decide", {
                approvalId,
                decision,
                ...options,
            }, signal),
        get: (approvalId) => port.request<ApprovalRequest>("get", { approvalId }),
        list: (options) => port.request<ApprovalRequest[]>("list", options),
        snapshot: (options, signal) => port.request<ApprovalListResult>("snapshot", options, signal),
        subscribe: async (fromSeq) =>
            new InstanceEventStream<ApprovalEvent>(
                instanceName,
                await port.open("subscribe", { fromSeq }),
            ),
    };
}
