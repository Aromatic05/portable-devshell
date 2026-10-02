// Context message wire contract. list/queue are RPC operations on the
// instance `contextMessage` port. list returns the authoritative records plus
// the instance sequence at read time, so a client can close the
// list-then-subscribe window by subscribing from lastSeq + 1. Message changes
// arrive on the shared instance event stream, which the message view model
// filters client-side.

import type { InstanceEventSubscribeRequest } from "../../runtime/activity/Contract.js";
import type {
    ContextMessageListInput,
    ContextMessageListResult,
    ContextMessageQueueInput,
    ContextMessageRecord,
} from "./Model.js";

export const contextMessageOperations = {
    list: "list",
    queue: "queue",
} as const;

export interface ContextMessageContract {
    list: {
        request: ContextMessageListInput;
        response: ContextMessageListResult;
    };
    queue: {
        request: ContextMessageQueueInput;
        response: ContextMessageRecord;
    };
}

export type ContextMessageOperation = keyof ContextMessageContract;

export type ContextMessageRequestPayload<
    Operation extends ContextMessageOperation,
> = ContextMessageContract[Operation]["request"];

export type ContextMessageResponse<Operation extends ContextMessageOperation> =
    ContextMessageContract[Operation]["response"];

export type ContextMessageSubscribeRequest = InstanceEventSubscribeRequest;