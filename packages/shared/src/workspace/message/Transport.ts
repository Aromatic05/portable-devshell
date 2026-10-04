import {
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import { CONTROL_HOST } from "../../client/Control.js";
import type {
    MessagePreferencesPatch,
    MessagePreferencesSnapshot,
} from "./Preference.js";
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
    MessageListInput,
    MessageListResult,
    MessageEvent,
} from "./Model.js";

export interface MessageTransport {
    listContextMessages(
        instance: string,
        input?: ContextMessageListInput,
    ): Promise<ContextMessageListResult>;
    listMessageEntries(
        instance: string,
        input?: MessageListInput,
    ): Promise<MessageListResult>;
    queueContextMessage(
        instance: string,
        input: ContextMessageQueueInput,
    ): Promise<ContextMessageRecord>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort<MessageEvent>>;
}

export interface MessagePreferenceTransport {
    getMessagePreferences(): Promise<MessagePreferencesSnapshot>;
    updateMessagePreferences(
        patch: MessagePreferencesPatch,
    ): Promise<MessagePreferencesSnapshot>;
}

export function createMessagePreferenceTransport(
    endpoint: Endpoint,
): MessagePreferenceTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "message");
    return {
        getMessagePreferences: () =>
            port.request<MessagePreferencesSnapshot>("preferences"),
        updateMessagePreferences: (patch) =>
            port.request<MessagePreferencesSnapshot>(
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
        listMessageEntries: (instance, input) =>
            port(instance).request<MessageListResult>(
                "listMessageEntries",
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
