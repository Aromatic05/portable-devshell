import type {
    ContextMessageRecord,
    MessageEntry,
} from "@portable-devshell/shared";

import type { BoxModel } from "../../../../layout/Box.js";
import type { TuiAppState } from "../../../../state/store/Model.js";
import type { TuiDomainReader } from "../../../../app/control/Reader.js";
import { readContextMessageDraft } from "../../../../state/editor/MessageDraft.js";
import { compactSummary, formatField, makeBox } from "../../Support.js";

export function buildAuditMessageBoxes(
    state: TuiAppState,
    reader: TuiDomainReader,
    instance: string,
    ctxId: string,
): BoxModel[] {
    const messages = (reader.messages.instances[instance]?.messages ?? [])
        .filter((message) => message.ctxId === ctxId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const delivered = (reader.messageHistory.instances[instance]?.entries ?? [])
        .filter(
            (entry) =>
                entry.ctxId === ctxId &&
                entry.kind === "comment" &&
                entry.status === "delivered",
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const pending = messages.filter(
        (message) => message.status === "pending" || message.status === "sent",
    );
    const failed = messages.filter((message) => message.status === "failed");

    return [
        ...delivered.map((entry) =>
            deliveredCommentBox(state, reader, instance, entry),
        ),
        ...(failed.length === 0
            ? []
            : [failedCommentBox(state, instance, failed)]),
        ...(pending.length === 0
            ? []
            : [pendingCommentBox(state, instance, pending)]),
        composerBox(state, instance, ctxId),
    ];
}

function deliveredCommentBox(
    state: TuiAppState,
    reader: TuiDomainReader,
    instance: string,
    entry: MessageEntry,
): BoxModel {
    const call = reader.toolCalls.instances[instance]?.calls.find(
        (candidate) => candidate.callId === entry.callId,
    );
    const callId = entry.callId ?? entry.id;
    const toolName = call?.toolName ?? "-";
    const completedAt =
        call?.completedAt ?? entry.deliveredAt ?? entry.createdAt;
    const comment = entry.text;
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Call ID", callId),
            formatField("Tool", toolName),
            formatField("Completed", completedAt),
            formatField("Comment", comment),
        ],
        id: `message-call:${callId}`,
        searchText: `${callId} ${toolName} ${comment}`,
        status: "ready",
        summaryLines: [
            compactSummary(
                ["call", callId],
                ["tool", toolName],
                ["completed", completedAt],
            ),
            comment,
        ],
        title: `Comment · ${toolName}`,
    });
}

function pendingCommentBox(
    state: TuiAppState,
    instance: string,
    messages: readonly ContextMessageRecord[],
): BoxModel {
    const comment = mergeCommentText(messages);
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Target", "next tool call"),
            formatField("Queued", messages[0]?.createdAt ?? "-"),
            formatField("Comments", String(messages.length)),
            formatField("Comment", comment),
        ],
        id: "message-pending",
        searchText: `pending next call ${comment}`,
        status: "pending",
        summaryLines: [
            compactSummary(
                ["target", "next call"],
                ["comments", String(messages.length)],
            ),
            comment,
        ],
        title: "Comment · next call",
    });
}

function failedCommentBox(
    state: TuiAppState,
    instance: string,
    messages: readonly ContextMessageRecord[],
): BoxModel {
    const comment = mergeCommentText(messages);
    const errors = [
        ...new Set(messages.flatMap((message) => message.error ?? [])),
    ].join("; ");
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Target", "next tool call"),
            formatField("Comments", String(messages.length)),
            formatField("Comment", comment),
            formatField(
                "Error",
                errors.length === 0 ? "delivery failed" : errors,
            ),
        ],
        id: "message-failed",
        searchText: `failed ${comment} ${errors}`,
        status: "failed",
        summaryLines: [
            compactSummary(
                ["delivery", "failed"],
                ["comments", String(messages.length)],
            ),
            `${comment}  error=${errors.length === 0 ? "delivery failed" : errors}`,
        ],
        title: "Comment · failed",
    });
}

function composerBox(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): BoxModel {
    const draft = readContextMessageDraft(state, instance, ctxId);
    const prefix = "Draft              ";
    const display = draft.length === 0 ? "<empty>" : draft;
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Context", ctxId),
            formatField("Delivery", "next tool call in this context"),
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
            "Enter queues this Comment for the next tool call.",
            "Esc or Ctrl+[ returns to the Audit Context.",
        ],
        expandedKey: `audit-message:${instance}:${ctxId}:composer`,
        editable: true,
        id: "message-composer",
        status: draft.length === 0 ? "normal" : "running",
        summaryLines: [
            draft.length === 0 ? "draft=<empty>" : `draft=${draft}`,
            "Space expand · ↑/↓ Draft · Enter edit · Esc back",
        ],
        title: "Write Comment",
    });
}

function mergeCommentText(messages: readonly ContextMessageRecord[]): string {
    return messages.map((message) => message.text).join("\n\n");
}
