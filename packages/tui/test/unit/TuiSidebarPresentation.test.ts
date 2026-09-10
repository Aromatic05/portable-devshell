import assert from "node:assert/strict";
import test from "node:test";

import {
    selectTuiSidebarViewport,
    tuiSidebarSectionRows,
} from "../../src/view/TuiSidebarPresentation.ts";

test("sidebar splits its inner height evenly between Context and Instances", () => {
    assert.deepEqual(tuiSidebarSectionRows(8), {
        contextRows: 3,
        instanceRows: 3,
    });
    assert.deepEqual(tuiSidebarSectionRows(9), {
        contextRows: 3,
        instanceRows: 4,
    });
});

test("sidebar viewport follows focus without changing the underlying list", () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
        focused: index === 7,
        id: `item-${index}`,
        label: `item-${index}`,
        selected: index === 0,
    }));
    const viewport = selectTuiSidebarViewport(items, 3);

    assert.equal(viewport.startIndex, 6);
    assert.deepEqual(
        viewport.items.map((item) => item.id),
        ["item-6", "item-7", "item-8"],
    );
    assert.equal(items.length, 9);
});
