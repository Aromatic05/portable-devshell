import assert from "node:assert/strict";
import test from "node:test";

import { TuiScreenTextSelection } from "../../src/runtime/TuiScreenTextSelection.ts";

test("screen text selection projects visible spans and exact clipboard text", async () => {
    const selection = new TuiScreenTextSelection({ columns: 20, rows: 4 });
    try {
        selection.write("\u001B[?1049h\u001B[2J\u001B[Hhello world\r\nsecond line");
        await selection.flush();

        await selection.beginSelection(2, 1);
        selection.updateSelection(6, 2);

        assert.equal(selection.getSelectionText(), "ello world\nsecond");
        assert.deepEqual(selection.getSnapshot(), {
            characters: 17,
            spans: [
                { column: 1, row: 0, text: "ello world" },
                { column: 0, row: 1, text: "second" },
            ],
        });

        selection.clearSelection();
        assert.deepEqual(selection.getSnapshot(), { characters: 0, spans: [] });
    } finally {
        selection.dispose();
    }
});

test("column bounds keep selection inside one pane and never leak the other column", async () => {
    const selection = new TuiScreenTextSelection({ columns: 30, rows: 3 });
    try {
        const line = (left: string, right: string): string =>
            left.padEnd(20) + right;
        selection.write(
            [line("L0", "R0"), line("L1", "R1"), line("L2", "R2")].join("\r\n"),
        );
        await selection.flush();

        await selection.beginSelection(21, 1);
        selection.updateSelection(22, 3);
        assert.ok(selection.getSelectionText().includes("L1"));

        await selection.beginSelection(21, 1, { end: 22, start: 20 });
        selection.updateSelection(22, 3);
        assert.equal(selection.getSelectionText(), "R0\nR1\nR2");
        assert.deepEqual(selection.getSnapshot().spans, [
            { column: 20, row: 0, text: "R0" },
            { column: 20, row: 1, text: "R1" },
            { column: 20, row: 2, text: "R2" },
        ]);
    } finally {
        selection.dispose();
    }
});
