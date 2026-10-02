// Thin typed approval transport. list/get/decide are RPC operations on the
// instance approval port. subscribe opens a server-filtered approval event
// stream and resumes from the cursor returned by list, so the projection never
// piggybacks on the generic runtime stream.

import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../transport/packet/Rpc.js";
import { Stream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { InstanceEventStreamPort } from "../activity/Contract.js";
import { InstanceEventStream } from "../activity/EventStream.js";
import { asInstanceName } from "../identity/Model.js";
import {
    approvalOperations,
    type ApprovalDecisionOptions,
    type ApprovalOperation,
    type ApprovalRequestPayload,
    type ApprovalResponse,
} from "./Contract.js";
import type { ApprovalDecisionValue, ApprovalRequest } from "./Model.js";

export const APPROVAL_PORT = "approval";

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
    ): Promise<ApprovalResponse<"list">>;
    snapshot(
        instance: string,
        options?: { pendingOnly?: boolean },
    ): Promise<ApprovalResponse<"snapshot">>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort>;
}

export function createApprovalTransport(endpoint: Endpoint): ApprovalTransport {
    const request = async <Operation extends ApprovalOperation>(
        instance: string,
        operation: Operation,
        payload: ApprovalRequestPayload<Operation>,
    ): Promise<ApprovalResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(instance, APPROVAL_PORT));
        try {
            return await rpc.request<ApprovalResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        decide: (instance, approvalId, decision, options = {}) =>
            request(instance, approvalOperations.decide, {
                approvalId,
                decision,
                ...options,
            }),
        get: (instance, approvalId) =>
            request(instance, approvalOperations.get, { approvalId }),
        list: (instance, options) =>
            request(instance, approvalOperations.list, options),
        snapshot: (instance, options) =>
            request(instance, approvalOperations.snapshot, options),
        subscribe: async (instance, fromSeq) => {
            const protocol = new Stream(
                await endpoint.connect(instance, APPROVAL_PORT),
            );
            const stream = await protocol.open(approvalOperations.subscribe, {
                fromSeq,
            } satisfies JsonValue);
            const close = () => protocol.close();
            stream.onClose(close);
            stream.onCancel(close);
            return new InstanceEventStream(asInstanceName(instance), stream);
        },
    };
}
