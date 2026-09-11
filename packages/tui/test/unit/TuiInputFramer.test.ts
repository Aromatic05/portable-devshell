import assert from "node:assert/strict";
import test from "node:test";

import { TuiInputFramer } from "../../src/testing.ts";

test("input framer splits burst and partial escape sequences", () => {
    const router = new TuiInputFramer();

    assert.deepEqual(router.push("4@"), [
        { data: "4", type: "data" },
        { data: "@", type: "data" },
    ]);

    router.reset();
    assert.deepEqual(router.push("\u001B[B\u001B[B"), [
        { data: "\u001B[B", type: "data" },
        { data: "\u001B[B", type: "data" },
    ]);

    router.reset();
    assert.deepEqual(router.push("\u001B\u001B[A"), [
        { data: "\u001B", type: "data" },
        { data: "\u001B[A", type: "data" },
    ]);

    router.reset();
    assert.deepEqual(router.push("\u001B["), []);
    assert.deepEqual(router.push("C"), [
        { data: "\u001B[C", type: "data" },
    ]);
});

test("input framer preserves mouse, text, and bracketed paste order", () => {
    const router = new TuiInputFramer();

    assert.deepEqual(
        router.push("a\u001B[<0;5;3Mb\u001B[200~x\u001B[B\u001B[201~c"),
        [
            { data: "a", type: "data" },
            { button: 0, kind: "press", type: "mouse", x: 5, y: 3 },
            { data: "b", type: "data" },
            { data: "x\u001B[B", type: "paste" },
            { data: "c", type: "data" },
        ],
    );
});

test("input framer preserves UTF-8 split across Buffer chunks", () => {
    const router = new TuiInputFramer();
    const bytes = Buffer.from("中文", "utf8");

    assert.deepEqual(router.push(bytes.subarray(0, 2)), []);
    assert.deepEqual(router.push(bytes.subarray(2)), [
        { data: "中", type: "data" },
        { data: "文", type: "data" },
    ]);
});
