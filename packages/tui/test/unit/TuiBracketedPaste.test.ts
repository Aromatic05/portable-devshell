import assert from "node:assert/strict";
import test from "node:test";

import { stripBracketedPasteMarkers } from "../../src/runtime/terminal/TuiBracketedPaste.js";

test("strips complete bracketed paste markers and keeps the pasted text", () => {
    assert.deepEqual(
        stripBracketedPasteMarkers("\u001B[200~hello\nworld\u001B[201~"),
        { partial: "", text: "hello\nworld" },
    );
});

test("holds back a trailing partial marker so a split paste still copies cleanly", () => {
    const first = stripBracketedPasteMarkers("\u001B[200~hello\u001B[20");
    assert.deepEqual(first, { partial: "\u001B[20", text: "hello" });

    assert.deepEqual(stripBracketedPasteMarkers(first.partial + "1~"), {
        partial: "",
        text: "",
    });
});

test("does not hold back a lone escape or ordinary text", () => {
    assert.deepEqual(stripBracketedPasteMarkers("\u001B"), {
        partial: "",
        text: "\u001B",
    });
    assert.deepEqual(stripBracketedPasteMarkers("\u001B["), {
        partial: "",
        text: "\u001B[",
    });
    assert.deepEqual(stripBracketedPasteMarkers("plain text"), {
        partial: "",
        text: "plain text",
    });
});
