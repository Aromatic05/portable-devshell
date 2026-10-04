import {
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import { CONTROL_HOST } from "../../client/Control.js";
import type {
    ConversationPreferencesPatch,
    ConversationPreferencesSnapshot,
} from "../../control/config/Preference.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type {
    ContextMessageListInput,
    ContextMessageListResult,
    ContextMessageQueueInput,
    ContextMessageRecord,
    ConversationListInput,
    ConversationListResult,
    MessageEvent,
} from "./Model.js";

export interface MessageTransport {
    listContextMessages(
        instance: string,
        input?: ContextMessageListInput,
    ): Promise<ContextMessageListResult>;
    listConversationEntries(
        instance: string,
        input?: ConversationListInput,
    ): Promise<ConversationListResult>;
    queueContextMessage(
        instance: string,
        input: ContextMessageQueueInput,
    ): Promise<ContextMessageRecord>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort<MessageEvent>>;
}

export interface ConversationPreferenceTransport {
    getConversationPreferences(): Promise<ConversationPreferencesSnapshot>;
    updateConversationPreferences(
        patch: ConversationPreferencesPatch,
    ): Promise<ConversationPreferencesSnapshot>;
}

export function createConversationPreferenceTransport(
    endpoint: Endpoint,
): ConversationPreferenceTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "conversation");
    return {
        getConversationPreferences: () =>
            port.request<ConversationPreferencesSnapshot>("preferences"),
        updateConversationPreferences: (patch) =>
            port.request<ConversationPreferencesSnapshot>(
                "updatePreferences",
                patch,
            ),
    };
}

export function createMessageTransport(endpoint: Endpoint): MessageTransport {
    const port = (instance: string): PortClient =>
        createPortClient(endpoint, instance, "message");
    return {
        listContextMessages: (instance, input) =>
            port(instance).request<ContextMessageListResult>(
                "listContextMessages",
                input ?? {},
            ),
        listConversationEntries: (instance, input) =>
            port(instance).request<ConversationListResult>(
                "listConversationEntries",
                input ?? {},
            ),
        queueContextMessage: (instance, input) =>
            port(instance).request<ContextMessageRecord>(
                "queueContextMessage",
                input,
            ),
        subscribe: async (instance, fromSeq) =>
            new InstanceEventStream<MessageEvent>(
                asInstanceName(instance),
                await port(instance).open("subscribe", { fromSeq }),
            ),
    };
}
