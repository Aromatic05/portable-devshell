import type {
    MessageEntry,
    MessageListInput,
} from "@portable-devshell/shared";

import {
    COMMENT_REPORT_CONVERSATION_WINDOW,
    duplicateReportError,
    reportRateLimitError,
} from "./Policy.js";
import { CommentReportState } from "./State.js";

export interface CommentReportPending {
    push?: { commentId: string; message: string };
    replyCommentId?: string;
}

export interface CommentReportMessageHistoryPort {
    list(input?: MessageListInput): Promise<MessageEntry[]>;
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
    readonly #messageHistory: CommentReportMessageHistoryPort;
    readonly #now: () => number;
    readonly #state: CommentReportState;

    constructor(options: {
        comment: CommentReportCommentPort;
        messageHistory: CommentReportMessageHistoryPort;
        now?: () => number;
        state?: CommentReportState;
    }) {
        this.#comment = options.comment;
        this.#messageHistory = options.messageHistory;
        this.#now = options.now ?? Date.now;
        this.#state = options.state ?? new CommentReportState();
    }

    async report(ctxId: string, message: string, callId: string): Promise<void> {
        await this.#state.withReport(ctxId, this.#now, async (state) => {
            const entries = await this.#messageHistory.list({
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
                    throw duplicateReportError(ctxId);
                }
                if (state.tokens < 1) {
                    throw reportRateLimitError();
                }
            }

            await this.#messageHistory.recordReport({
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
