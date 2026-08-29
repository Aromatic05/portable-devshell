import type { ContextMessageRecord, JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { readContextConversationDraft } from "../../../interaction/command/dispatcher/TuiCommandDispatcherNavigation.js";
import {
    isLatestObservedContext,
    latestObservedContextId,
} from "../../../state/audit/TuiAuditContextActivity.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";

export function buildAuditConversationBoxes(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): BoxModel[] {
    const messages = (state.readModel.instanceState[instance]?.contextMessages ?? [])
        .filter((message) => message.ctxId === ctxId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const deliveredCalls = (state.readModel.instanceState[instance]?.commentCalls ?? [])
        .filter((call) => call.ctxId === ctxId && readCallComments(call).length > 0)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const pending = messages.filter(
        (message) => message.status === "pending" || message.status === "sent",
    );
    const failed = messages.filter((message) => message.status === "failed");

    return [
        ...deliveredCalls.map((call) => deliveredCommentBox(state, instance, call)),
        ...(failed.length === 0 ? [] : [failedCommentBox(state, instance, failed)]),
        ...(pending.length === 0 ? [] : [pendingCommentBox(state, instance, pending)]),
        composerBox(state, instance, ctxId),
    ];
}

function deliveredCommentBox(
    state: TuiAppState,
    instance: string,
    call: ToolCallRecord,
): BoxModel {
    const comments = readCallComments(call);
    const comment = comments.join("\n\n");
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Call ID", call.callId),
            formatField("Tool", call.toolName),
            formatField("Completed", call.completedAt ?? "-"),
            formatField("Comment", comment),
        ],
        id: `conversation-call:${call.callId}`,
        searchText: `${call.callId} ${call.toolName} ${comment}`,
        status: "ready",
        summaryLines: [
            compactSummary(
                ["call", call.callId],
                ["tool", call.toolName],
                ["completed", call.completedAt ?? call.startedAt],
            ),
            comment,
        ],
        title: `Comment · ${call.toolName}`,
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
        id: "conversation-pending",
        searchText: `pending next call ${comment}`,
        status: "pending",
        summaryLines: [
            compactSummary(["target", "next call"], ["comments", String(messages.length)]),
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
    const errors = [...new Set(messages.flatMap((message) => message.error ?? []))].join("; ");
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Target", "next tool call"),
            formatField("Comments", String(messages.length)),
            formatField("Comment", comment),
            formatField("Error", errors.length === 0 ? "delivery failed" : errors),
        ],
        id: "conversation-failed",
        searchText: `failed ${comment} ${errors}`,
        status: "failed",
        summaryLines: [
            compactSummary(["delivery", "failed"], ["comments", String(messages.length)]),
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
    const draft = readContextConversationDraft(state, instance, ctxId);
    const current = isLatestObservedContext(state, instance, ctxId);
    const latest = latestObservedContextId(state, instance);
    const prefix = "Draft              ";
    const display = draft.length === 0 ? "<empty>" : draft;
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Context", ctxId),
            formatField(
                "Delivery",
                current
                    ? "next tool call in this context"
                    : `blocked; latest observed context is ${latest ?? "unknown"}`,
            ),
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
            current
                ? "Enter queues this Comment for the next tool call."
                : "Sending is blocked because this context is no longer current.",
            "Esc or Ctrl+[ returns to the Audit Context.",
        ],
        expandedKey: `audit-conversation:${instance}:${ctxId}:composer`,
        editable: true,
        id: "conversation-composer",
        status: current ? (draft.length === 0 ? "normal" : "running") : "disabled",
        summaryLines: [
            draft.length === 0 ? "draft=<empty>" : `draft=${draft}`,
            current
                ? "Space expand · ↑/↓ Draft · Enter edit · Esc back"
                : `sending blocked · latest=${latest ?? "unknown"}`,
        ],
        title: "Write Comment",
    });
}

function mergeCommentText(messages: readonly ContextMessageRecord[]): string {
    return messages.map((message) => message.text).join("\n\n");
}

function readCallComments(call: ToolCallRecord): string[] {
    return readComments(call.output);
}

function readComments(value: JsonValue | undefined): string[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const comment = (value as Record<string, JsonValue>).comment;
    return Array.isArray(comment) && comment.every((entry) => typeof entry === "string")
        ? comment
        : [];
}
