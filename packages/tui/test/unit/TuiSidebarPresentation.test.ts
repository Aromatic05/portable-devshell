import assert from "node:assert/strict";
import test from "node:test";

import {
    selectTuiSidebarViewport,
    tuiSidebarRegions,
    tuiSidebarSectionAt,
    tuiSidebarSectionRows,
} from "../../src/view/TuiSidebarPresentation.ts";

test("sidebar reserves a divider row and splits the remaining height between Context and Instances", () => {
    assert.deepEqual(tuiSidebarSectionRows(8), {
        contextRows: 2,
        instanceRows: 3,
    });
    assert.deepEqual(tuiSidebarSectionRows(9), {
        contextRows: 3,
        instanceRows: 3,
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

test("sidebar geometry reserves the divider between independently scrollable sections", () => {
    const regions = tuiSidebarRegions({ columns: 120, rows: 40 });
    assert.ok(regions);
    assert.equal(
        regions.instances.y,
        regions.context.y + regions.context.height + 1,
    );
    assert.equal(
        tuiSidebarSectionAt(
            { columns: 120, rows: 40 },
            regions.context.x,
            regions.context.y,
        ),
        "context",
    );
    assert.equal(
        tuiSidebarSectionAt(
            { columns: 120, rows: 40 },
            regions.instances.x,
            regions.instances.y,
        ),
        "instances",
    );
    assert.equal(
        tuiSidebarSectionAt(
            { columns: 120, rows: 40 },
            regions.context.x,
            regions.context.y + regions.context.height,
        ),
        undefined,
    );
});

test("compact sidebar keeps separate clickable rows for Context and Instances", () => {
    const regions = tuiSidebarRegions({ columns: 80, rows: 20 });
    assert.ok(regions);
    assert.deepEqual(regions.context, {
        height: 1,
        width: 80,
        x: 1,
        y: 4,
    });
    assert.deepEqual(regions.instances, {
        height: 1,
        width: 80,
        x: 1,
        y: 5,
    });
    assert.equal(tuiSidebarSectionAt({ columns: 80, rows: 20 }, 10, 4), "context");
    assert.equal(tuiSidebarSectionAt({ columns: 80, rows: 20 }, 10, 5), "instances");
});
