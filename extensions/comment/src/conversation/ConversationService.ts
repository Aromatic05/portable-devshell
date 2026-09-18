import type {
    ConversationEntry,
    ConversationListInput,
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
