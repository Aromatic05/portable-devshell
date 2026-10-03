// Conversation wire contract. list is an RPC on the instance `conversation`
// port and returns the authoritative entries plus the instance sequence at read
// time, so a client can close the list-then-subscribe window by subscribing
// from lastSeq + 1; preferences/updatePreferences are control operations on the
// control `conversation` port. Conversation changes arrive on the shared
// instance event stream, which the conversation view model filters client-side.

import type { InstanceEventSubscribeRequest } from "../../runtime/activity/Contract.js";
import type {
    ConversationListInput,
    ConversationListResult,
    ConversationPreferencesPatch,
    ConversationPreferencesSnapshot,
} from "./Model.js";

export const conversationOperations = {
    list: "list",
} as const;

export interface ConversationContract {
    list: {
        request: ConversationListInput;
        response: ConversationListResult;
    };
}

export type ConversationOperation = keyof ConversationContract;

export type ConversationRequestPayload<
    Operation extends ConversationOperation,
> = ConversationContract[Operation]["request"];

export type ConversationResponse<Operation extends ConversationOperation> =
    ConversationContract[Operation]["response"];

export const conversationPreferenceOperations = {
    preferences: "preferences",
    updatePreferences: "updatePreferences",
} as const;

export interface ConversationPreferenceContract {
    preferences: {
        request: undefined;
        response: ConversationPreferencesSnapshot;
    };
    updatePreferences: {
        request: ConversationPreferencesPatch;
        response: ConversationPreferencesSnapshot;
    };
}

export type ConversationPreferenceOperation =
    keyof ConversationPreferenceContract;

export type ConversationPreferenceRequestPayload<
    Operation extends ConversationPreferenceOperation,
> = ConversationPreferenceContract[Operation]["request"];

export type ConversationPreferenceResponse<
    Operation extends ConversationPreferenceOperation,
> = ConversationPreferenceContract[Operation]["response"];

export type ConversationSubscribeRequest = InstanceEventSubscribeRequest;