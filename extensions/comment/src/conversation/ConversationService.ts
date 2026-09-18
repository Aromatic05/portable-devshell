import { createError, errorCodes } from "@portable-devshell/shared";
import type {
    ConversationEntry,
    ConversationListInput,
    JsonValue,
    PrefixRouteModuleDefinition,
    ToolCallRecord,
} from "@portable-devshell/shared";

import { migrateLegacyReports } from "./migration/Report.js";
import { ConversationStore } from "./store/ConversationStore.js";

export class ConversationService {
    readonly #legacyReports?: () => Promise<ToolCallRecord[]>;
    readonly #store: ConversationStore;
    #migration?: Promise<void>;

    constructor(options: {
        legacyReports?: () => Promise<ToolCallRecord[]>;
        store: ConversationStore;
    }) {
        this.#legacyReports = options.legacyReports;
        this.#store = options.store;
    }

    async list(
        input: ConversationListInput = {},
    ): Promise<ConversationEntry[]> {
        await this.#ensureLegacyReportsMigrated();
        return this.#store.list(input);
    }

    async recordReport(input: {
        callId: string;
        createdAt?: string;
        ctxId: string;
        replyCommentId?: string;
        text: string;
    }): Promise<void> {
        await this.#ensureLegacyReportsMigrated();
        this.#store.appendReport({
            callId: input.callId,
            createdAt: input.createdAt ?? new Date().toISOString(),
            ctxId: input.ctxId,
            ...(input.replyCommentId === undefined
                ? {}
                : { replyCommentId: input.replyCommentId }),
            text: input.text,
        });
    }

    close(): void {
        this.#store.close();
    }

    async #ensureLegacyReportsMigrated(): Promise<void> {
        if (this.#store.isLegacyReportMigrationComplete()) return;
        if (this.#migration !== undefined) return await this.#migration;
        this.#migration = migrateLegacyReports(this.#store, this.#legacyReports);
        try {
            await this.#migration;
        } finally {
            this.#migration = undefined;
        }
    }

}

export function createConversationRouteModule(
    service: Pick<ConversationService, "list">,
): PrefixRouteModuleDefinition {
    return {
        name: "conversation",
        operations: [
            {
                name: "list",
                handle: async (request) =>
                    (await service.list(
                        readConversationListInput(request.payload ?? {}),
                    )) as unknown as JsonValue,
            },
        ],
    };
}

function readConversationListInput(value: JsonValue): ConversationListInput {
    if (
        !isRecord(value) ||
        Object.keys(value).some(
            (key) => !["before", "ctxId", "limit", "maxBytes"].includes(key),
        )
    )
        throw invalidRouteInput(
            "conversation.list accepts only before, ctxId, limit, and maxBytes.",
        );
    if (value.before !== undefined && typeof value.before !== "string")
        throw invalidRouteInput("conversation.list before must be a string.");
    if (value.ctxId !== undefined && typeof value.ctxId !== "string")
        throw invalidRouteInput("conversation.list ctxId must be a string.");
    if (
        value.limit !== undefined &&
        (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit))
    )
        throw invalidRouteInput("conversation.list limit must be an integer.");
    if (
        value.maxBytes !== undefined &&
        (typeof value.maxBytes !== "number" ||
            !Number.isSafeInteger(value.maxBytes))
    )
        throw invalidRouteInput("conversation.list maxBytes must be an integer.");
    return {
        ...(value.before === undefined ? {} : { before: value.before }),
        ...(value.ctxId === undefined ? {} : { ctxId: value.ctxId }),
        ...(value.limit === undefined
            ? {}
            : { limit: Math.min(Math.max(value.limit, 1), 1_000) }),
        ...(value.maxBytes === undefined
            ? {}
            : { maxBytes: Math.min(Math.max(value.maxBytes, 1), 1024 * 1024) }),
    };
}

function invalidRouteInput(message: string): Error {
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false,
    });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
