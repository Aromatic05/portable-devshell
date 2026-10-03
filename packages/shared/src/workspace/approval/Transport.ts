// Approval reads and decisions use the instance approval port. The dedicated
// event stream resumes from the cursor carried by the authoritative snapshot.

import {
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
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
        instance: string,
        approvalId: string,
        decision: ApprovalDecisionValue,
        options?: ApprovalDecisionOptions,
    ): Promise<ApprovalRequest>;
    get(instance: string, approvalId: string): Promise<ApprovalRequest>;
    list(
        instance: string,
        options?: { pendingOnly?: boolean },
    ): Promise<ApprovalRequest[]>;
    snapshot(
        instance: string,
        options?: { pendingOnly?: boolean },
    ): Promise<ApprovalListResult>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort<ApprovalEvent>>;
}

export function createApprovalTransport(endpoint: Endpoint): ApprovalTransport {
    const port = (instance: string): PortClient =>
        createPortClient(endpoint, instance, "approval");
    return {
        decide: (instance, approvalId, decision, options = {}) =>
            port(instance).request<ApprovalRequest>("decide", {
                approvalId,
                decision,
                ...options,
            }),
        get: (instance, approvalId) =>
            port(instance).request<ApprovalRequest>("get", { approvalId }),
        list: (instance, options) =>
            port(instance).request<ApprovalRequest[]>("list", options),
        snapshot: (instance, options) =>
            port(instance).request<ApprovalListResult>("snapshot", options),
        subscribe: async (instance, fromSeq) =>
            new InstanceEventStream<ApprovalEvent>(
                asInstanceName(instance),
                await port(instance).open("subscribe", { fromSeq }),
            ),
    };
}
