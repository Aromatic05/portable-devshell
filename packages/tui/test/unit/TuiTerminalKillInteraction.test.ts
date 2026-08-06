import assert from "node:assert/strict";
import test from "node:test";

import { TuiKeyDispatcher } from "../../src/interaction/input/TuiKeyDispatcher.js";

test("terminal kill shortcut is available only after leaving raw terminal input", () => {
    const dispatcher = new TuiKeyDispatcher();

    assert.deepEqual(
        dispatcher.dispatch("sidebarPages", {
            input: "K",
            key: { shift: true },
        }),
        [{ type: "terminal.requestKill" }],
    );
    assert.deepEqual(
        dispatcher.dispatch("terminal", {
            input: "K",
            key: { shift: true },
        }),
        [],
    );
});
