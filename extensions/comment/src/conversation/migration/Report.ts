import type { ToolCallRecord } from "@portable-devshell/shared";

export interface LegacyReportMigrationStore {
    appendReport(input: {
        callId: string;
        createdAt: string;
        ctxId: string;
        text: string;
    }): void;
    completeLegacyReportMigration(): void;
    isLegacyReportMigrationComplete(): boolean;
}

export async function migrateLegacyReports(
    store: LegacyReportMigrationStore,
    load: (() => Promise<ToolCallRecord[]>) | undefined,
): Promise<void> {
    if (store.isLegacyReportMigrationComplete()) return;
    const calls = (await load?.()) ?? [];
    for (const call of calls) {
        if (
            call.toolName !== "todo_report" ||
            call.status !== "completed" ||
            call.ctxId === undefined
        )
            continue;
        const text = reportText(call);
        if (text === undefined) continue;
        store.appendReport({
            callId: call.callId,
            createdAt: call.completedAt ?? call.startedAt,
            ctxId: call.ctxId,
            text,
        });
    }
    store.completeLegacyReportMigration();
}

function reportText(call: ToolCallRecord): string | undefined {
    if (
        typeof call.input !== "object" ||
        call.input === null ||
        Array.isArray(call.input)
    )
        return undefined;
    const message = call.input.message;
    return typeof message === "string" && message.length > 0
        ? message
        : undefined;
}

export const LEGACY_REPORT_MIGRATION_KEY = "migration:todo-report-audit-v1";

export function isLegacyReportMigrationComplete(database: import("node:sqlite").DatabaseSync): boolean {
    const row = database
        .prepare("SELECT value FROM conversation_metadata WHERE key = ?")
        .get(LEGACY_REPORT_MIGRATION_KEY) as { value: string } | undefined;
    return row?.value === "complete";
}

export function completeLegacyReportMigration(database: import("node:sqlite").DatabaseSync): void {
    database
        .prepare(
            `
            INSERT INTO conversation_metadata(key, value) VALUES (?, 'complete')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(LEGACY_REPORT_MIGRATION_KEY);
}
