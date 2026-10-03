// Approval wire contract. list returns the authoritative pending set plus the
// instance sequence at read time; without that cursor a client cannot close the
// list-then-subscribe window, so it is part of the contract rather than
// inferred. subscribe is a server-filtered approval stream that resumes from
// that cursor.

import type { InstanceEventSubscribeRequest } from "../activity/Contract.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type {
    ApprovalDecisionValue,
    ApprovalListResult,
    ApprovalRequest,
} from "./Model.js";

export const approvalOperations = {
    decide: "decide",
    get: "get",
    list: "list",
    snapshot: "snapshot",
    subscribe: "subscribe",
} as const;

export interface ApprovalDecisionOptions {
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

export interface ApprovalContract {
    decide: {
        request: {
            approvalId: string;
            decision: ApprovalDecisionValue;
        } & ApprovalDecisionOptions;
        response: ApprovalRequest;
    };
    get: {
        request: { approvalId: string };
        response: ApprovalRequest;
    };
    list: {
        request: { pendingOnly?: boolean } | undefined;
        response: ApprovalRequest[];
    };
    snapshot: {
        request: { pendingOnly?: boolean } | undefined;
        response: ApprovalListResult;
    };
}

export type ApprovalOperation = keyof ApprovalContract;

export type ApprovalRequestPayload<Operation extends ApprovalOperation> =
    ApprovalContract[Operation]["request"];

export type ApprovalResponse<Operation extends ApprovalOperation> =
    ApprovalContract[Operation]["response"];

export type ApprovalSubscribeRequest = InstanceEventSubscribeRequest;
