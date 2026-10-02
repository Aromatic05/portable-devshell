// Thin typed Conversation transport. list opens an RPC on the instance
// `conversation` port and carries the read-time sequence so the caller can
// resume from lastSeq + 1; preferences/updatePreferences use the control
// `conversation` port; subscribe reuses the shared instance event stream through
// the instance activity contract.

import { CONTROL_HOST } from "../../control/connection/Control.js";
import type {
    InstanceEventSource,
    InstanceEventStreamPort,
} from "../../runtime/activity/Contract.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../transport/packet/Rpc.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import {
    conversationOperations,
    conversationPreferenceOperations,
    type ConversationOperation,
    type ConversationPreferenceOperation,
    type ConversationPreferenceRequestPayload,
    type ConversationPreferenceResponse,
    type ConversationRequestPayload,
    type ConversationResponse,
} from "./Contract.js";
import type {
    ConversationListInput,
    ConversationListResult,
    ConversationPreferencesPatch,
    ConversationPreferencesSnapshot,
} from "./Model.js";

export const CONVERSATION_PORT = "conversation";

export interface ConversationTransport {
    list(
        instance: string,
        input?: ConversationListInput,
    ): Promise<ConversationListResult>;
    readPreferences(): Promise<ConversationPreferencesSnapshot>;
    updatePreferences(
        patch: ConversationPreferencesPatch,
    ): Promise<ConversationPreferencesSnapshot>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort>;
}

export function createConversationTransport(
    endpoint: Endpoint,
    events: InstanceEventSource,
): ConversationTransport {
    const preferencePort = createPortClient(
        endpoint,
        CONTROL_HOST,
        CONVERSATION_PORT,
    );
    const preferenceRequest = <
        Operation extends ConversationPreferenceOperation,
    >(
        operation: Operation,
        payload: ConversationPreferenceRequestPayload<Operation>,
    ): Promise<ConversationPreferenceResponse<Operation>> =>
        preferencePort.request<ConversationPreferenceResponse<Operation>>(
            operation,
            payload,
        );
    const list = async <Operation extends ConversationOperation>(
        instance: string,
        operation: Operation,
        payload: ConversationRequestPayload<Operation>,
    ): Promise<ConversationResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(instance, CONVERSATION_PORT));
        try {
            return await rpc.request<ConversationResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        list: (instance, input) =>
            list(instance, conversationOperations.list, input ?? {}),
        readPreferences: () =>
            preferenceRequest(
                conversationPreferenceOperations.preferences,
                undefined,
            ),
        updatePreferences: (patch) =>
            preferenceRequest(
                conversationPreferenceOperations.updatePreferences,
                patch,
            ),
        subscribe: (instance, fromSeq) => events.subscribe(instance, fromSeq),
    };
}