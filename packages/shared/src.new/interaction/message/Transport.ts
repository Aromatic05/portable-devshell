// Thin typed Context message transport. list/queue open one RPC per operation on
// the instance `contextMessage` port; list carries the read-time sequence so the
// caller can resume from lastSeq + 1. subscribe reuses the shared instance event
// stream through the instance activity contract.

import type { InstanceEventSource, InstanceEventStreamPort } from "../../runtime/activity/Contract.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../transport/packet/Rpc.js";
import {
    contextMessageOperations,
    type ContextMessageOperation,
    type ContextMessageRequestPayload,
    type ContextMessageResponse,
} from "./Contract.js";
import type {
    ContextMessageListInput,
    ContextMessageListResult,
    ContextMessageQueueInput,
    ContextMessageRecord,
} from "./Model.js";

export const CONTEXT_MESSAGE_PORT = "contextMessage";

export interface MessageTransport {
    list(
        instance: string,
        input?: ContextMessageListInput,
    ): Promise<ContextMessageListResult>;
    queue(
        instance: string,
        input: ContextMessageQueueInput,
    ): Promise<ContextMessageRecord>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort>;
}

export function createMessageTransport(
    endpoint: Endpoint,
    events: InstanceEventSource,
): MessageTransport {
    const request = async <Operation extends ContextMessageOperation>(
        instance: string,
        operation: Operation,
        payload: ContextMessageRequestPayload<Operation>,
    ): Promise<ContextMessageResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(instance, CONTEXT_MESSAGE_PORT));
        try {
            return await rpc.request<ContextMessageResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        list: (instance, input) =>
            request(instance, contextMessageOperations.list, input ?? {}),
        queue: (instance, input) =>
            request(instance, contextMessageOperations.queue, input),
        subscribe: (instance, fromSeq) => events.subscribe(instance, fromSeq),
    };
}