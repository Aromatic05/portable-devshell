import type { ContextMessageRecord } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { readContextConversationDraft } from "../../../interaction/command/dispatcher/TuiCommandDispatcherNavigation.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";

export function buildAuditConversationBoxes(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): BoxModel[] {
    const messages = (state.contextMessagesByInstance[instance] ?? [])
        .filter((message) => message.ctxId === ctxId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return [
        ...messages.map((message) => messageBox(state, instance, message)),
        composerBox(state, instance, ctxId),
    ];
}

function messageBox(
    state: TuiAppState,
    instance: string,
    message: ContextMessageRecord,
): BoxModel {
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Message", message.id),
            formatField("Context", message.ctxId),
            formatField("Created", message.createdAt),
            formatField("Status", message.status),
            ...(message.deliveredAt === undefined
                ? []
                : [formatField("Delivered", message.deliveredAt)]),
            ...(message.failedAt === undefined
                ? []
                : [formatField("Failed", message.failedAt)]),
            ...(message.error === undefined
                ? []
                : [formatField("Error", message.error)]),
            formatField("Text", message.text),
        ],
        id: `conversation-message:${message.id}`,
        searchText: `${message.status} ${message.createdAt} ${message.text} ${message.error ?? ""}`,
        status:
            message.status === "delivered"
                ? "ready"
                : message.status === "failed"
                  ? "failed"
                  : message.status === "sent"
                    ? "running"
                    : "pending",
        summaryLines: [
            compactSummary(["status", message.status], ["created", message.createdAt]),
            message.error === undefined
                ? message.text
                : `${message.text}  error=${message.error}`,
        ],
        title: `Comment · ${message.status}`,
    });
}

function composerBox(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): BoxModel {
    const draft = readContextConversationDraft(state, instance, ctxId);
    const prefix = "Draft              ";
    const display = draft.length === 0 ? "<empty>" : draft;
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Context", ctxId),
            {
                editable: true,
                editableValue: {
                    emptyPlaceholder: "<empty>",
                    kind: "text",
                    prefix,
                    value: draft,
                },
                id: "draft",
                text: `${prefix}${display}`,
            },
            "Enter queues the Comment.",
            "Esc or Ctrl+[ returns to the Audit Context.",
        ],
        expandedKey: `audit-conversation:${instance}:${ctxId}:composer`,
        editable: true,
        id: "conversation-composer",
        status: draft.length === 0 ? "normal" : "running",
        summaryLines: [
            draft.length === 0 ? "draft=<empty>" : `draft=${draft}`,
            "Enter edit · Space expand · Esc back",
        ],
        title: "Write Comment",
    });
}
