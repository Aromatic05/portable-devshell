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
