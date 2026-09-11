import type {
    ConversationEntry,
    ConversationListInput,
    ToolCallRecord,
} from "@portable-devshell/shared";

import { ConversationStore } from "./ConversationStore.js";

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

    async list(input: ConversationListInput = {}): Promise<ConversationEntry[]> {
        await this.#ensureLegacyReportsMigrated();
        return this.#store.list(input);
    }

    async recordReport(input: { callId: string; createdAt?: string; ctxId: string; text: string }): Promise<void> {
        await this.#ensureLegacyReportsMigrated();
        this.#store.appendReport({
            callId: input.callId,
            createdAt: input.createdAt ?? new Date().toISOString(),
            ctxId: input.ctxId,
            text: input.text,
        });
    }

    close(): void {
        this.#store.close();
    }

    async #ensureLegacyReportsMigrated(): Promise<void> {
        if (this.#store.isLegacyReportMigrationComplete()) return;
        if (this.#migration !== undefined) return await this.#migration;
        this.#migration = this.#migrateLegacyReports();
        try {
            await this.#migration;
        } finally {
            this.#migration = undefined;
        }
    }

    async #migrateLegacyReports(): Promise<void> {
        const calls = await this.#legacyReports?.() ?? [];
        for (const call of calls) {
            if (call.toolName !== "todo_report" || call.status !== "completed" || call.ctxId === undefined) continue;
            const text = reportText(call);
            if (text === undefined) continue;
            this.#store.appendReport({
                callId: call.callId,
                createdAt: call.completedAt ?? call.startedAt,
                ctxId: call.ctxId,
                text,
            });
        }
        this.#store.completeLegacyReportMigration();
    }
}

function reportText(call: ToolCallRecord): string | undefined {
    if (typeof call.input !== "object" || call.input === null || Array.isArray(call.input)) return undefined;
    const message = call.input.message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
}
