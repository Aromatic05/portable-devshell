import type {
    ConversationEntry,
    ConversationListInput,
} from "@portable-devshell/shared";

import {
    COMMENT_REPORT_CONVERSATION_WINDOW,
    duplicateReportError,
    todoUseOtherToolsError,
} from "./Policy.js";
import { CommentReportState } from "./State.js";

export interface CommentReportPending {
    push?: { commentId: string; message: string };
    replyCommentId?: string;
}

export interface CommentReportConversationPort {
    list(input?: ConversationListInput): Promise<ConversationEntry[]>;
    recordReport(input: {
        callId: string;
        createdAt?: string;
        ctxId: string;
        push?: { commentId: string; message: string };
        replyCommentId?: string;
        text: string;
    }): Promise<void>;
}

export interface CommentReportCommentPort {
    pendingReport(ctxId: string): Promise<CommentReportPending>;
}

export class CommentReportService {
    readonly #comment: CommentReportCommentPort;
    readonly #conversation: CommentReportConversationPort;
    readonly #now: () => number;
    readonly #state: CommentReportState;

    constructor(options: {
        comment: CommentReportCommentPort;
        conversation: CommentReportConversationPort;
        now?: () => number;
        state?: CommentReportState;
    }) {
        this.#comment = options.comment;
        this.#conversation = options.conversation;
        this.#now = options.now ?? Date.now;
        this.#state = options.state ?? new CommentReportState();
    }

    async beforeTodoToolCall(ctxId: string, toolName: string): Promise<void> {
        if (!isTodoTool(toolName)) return;
        this.#state.assertTodoEnabled(ctxId, this.#now());
        if (toolName === "todo_read" || toolName === "todo_write") {
            await this.#state.consumeTodoAccess(ctxId, this.#now());
        }
    }

    recordTodoInvalid(ctxId: string): void {
        this.#state.recordInvalid(ctxId, this.#now());
    }

    async report(ctxId: string, message: string, callId: string): Promise<void> {
        await this.#state.withReport(ctxId, this.#now, async (state) => {
            const entries = await this.#conversation.list({
                ctxId,
                limit: COMMENT_REPORT_CONVERSATION_WINDOW,
            });
            state.lastReportMessage = [...entries]
                .reverse()
                .find((entry) => entry.kind === "report")?.text;

            const pending = await this.#comment.pendingReport(ctxId);
            const replyRequired =
                pending.replyCommentId !== undefined || pending.push !== undefined;
            if (!replyRequired) {
                if (state.lastReportMessage === message) {
                    this.recordTodoInvalid(ctxId);
                    throw duplicateReportError(ctxId);
                }
                if (state.tokens < 1) {
                    this.recordTodoInvalid(ctxId);
                    throw todoUseOtherToolsError();
                }
            }

            await this.#conversation.recordReport({
                callId,
                ctxId,
                ...(pending.push === undefined ? {} : { push: pending.push }),
                ...(pending.replyCommentId === undefined
                    ? {}
                    : { replyCommentId: pending.replyCommentId }),
                text: message,
            });
            if (!replyRequired) state.tokens -= 1;
            state.lastReportMessage = message;
        });
    }
}

function isTodoTool(toolName: string): boolean {
    return (
        toolName === "todo_read" ||
        toolName === "todo_report" ||
        toolName === "todo_write"
    );
}
