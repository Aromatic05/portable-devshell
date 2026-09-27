import type { WebPageSnapshot } from "@portable-devshell/extension/web";

export function validateWebPageSnapshot(
    value: WebPageSnapshot,
    pageId: string,
): WebPageSnapshot {
    if (!isRecord(value) || !Array.isArray(value.tables))
        throw new TypeError(`Web page ${pageId} returned an invalid snapshot.`);
    const tableIds = new Set<string>();
    for (const table of value.tables) {
        if (
            !isRecord(table) ||
            !Array.isArray(table.columns) ||
            !Array.isArray(table.rows)
        )
            throw new TypeError(`Web page ${pageId} returned an invalid table.`);
        const tableId = readText(table.id, pageId, "table id");
        assertUnique(tableIds, tableId, pageId, "table id");
        if (table.title !== undefined)
            readText(table.title, pageId, "table title");

        const columnIds = new Set<string>();
        for (const column of table.columns) {
            if (!isRecord(column)) invalid(pageId, "column");
            const columnId = readText(column.id, pageId, "column id");
            assertUnique(columnIds, columnId, pageId, "column id");
            readText(column.label, pageId, "column label");
        }

        const rowIds = new Set<string>();
        for (const row of table.rows) {
            if (!isRecord(row) || !isRecord(row.cells)) invalid(pageId, "row");
            const rowId = readText(row.id, pageId, "row id");
            assertUnique(rowIds, rowId, pageId, "row id");
            for (const [columnId, cell] of Object.entries(row.cells)) {
                if (!columnIds.has(columnId))
                    invalid(pageId, `cell column ${columnId}`);
                validateCell(cell, pageId);
            }
            if (row.actions !== undefined) {
                if (!Array.isArray(row.actions)) invalid(pageId, "row actions");
                const actionIds = new Set<string>();
                for (const action of row.actions) {
                    if (!isRecord(action)) invalid(pageId, "row action");
                    const actionId = readText(action.id, pageId, "action id");
                    assertUnique(actionIds, actionId, pageId, "action id");
                    readText(action.label, pageId, "action label");
                    if (
                        action.tone !== undefined &&
                        action.tone !== "normal" &&
                        action.tone !== "danger"
                    )
                        invalid(pageId, "action tone");
                }
            }
        }
    }
    return structuredClone(value);
}

function validateCell(value: unknown, pageId: string): void {
    if (!isRecord(value)) invalid(pageId, "cell");
    readText(value.text, pageId, "cell text");
    if (
        value.tone !== undefined &&
        value.tone !== "normal" &&
        value.tone !== "success" &&
        value.tone !== "warning" &&
        value.tone !== "danger"
    )
        invalid(pageId, "cell tone");
    if (value.href === undefined) return;
    const href = readText(value.href, pageId, "cell href");
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        invalid(pageId, "cell href");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        invalid(pageId, "cell href protocol");
}

function readText(value: unknown, pageId: string, label: string): string {
    if (
        typeof value === "string" &&
        value.length > 0 &&
        value.trim() === value
    )
        return value;
    return invalid(pageId, label);
}

function assertUnique(
    values: Set<string>,
    value: string,
    pageId: string,
    label: string,
): void {
    if (values.has(value)) invalid(pageId, `duplicate ${label}`);
    values.add(value);
}

function invalid(pageId: string, label: string): never {
    throw new TypeError(`Web page ${pageId} returned invalid ${label}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
