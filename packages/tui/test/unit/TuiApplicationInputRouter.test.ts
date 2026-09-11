import assert from "node:assert/strict";
import test from "node:test";

import { TuiApplicationInputRouter } from "../../src/testing.ts";

test("application input router splits burst and partial escape sequences", () => {
    const router = new TuiApplicationInputRouter();

    assert.deepEqual(router.push("4@"), [
        { data: "4", type: "ink" },
        { data: "@", type: "ink" },
    ]);

    router.reset();
    assert.deepEqual(router.push("\u001B[B\u001B[B"), [
        { data: "\u001B[B", type: "ink" },
        { data: "\u001B[B", type: "ink" },
    ]);

    router.reset();
    assert.deepEqual(router.push("\u001B["), []);
    assert.deepEqual(router.push("C"), [
        { data: "\u001B[C", type: "ink" },
    ]);
});

test("application input router preserves mouse, text, and bracketed paste order", () => {
    const router = new TuiApplicationInputRouter();

    assert.deepEqual(
        router.push("a\u001B[<0;5;3Mb\u001B[200~x\u001B[B\u001B[201~c"),
        [
            { data: "a", type: "ink" },
            { button: 0, kind: "press", type: "mouse", x: 5, y: 3 },
            { data: "b", type: "ink" },
            { data: "x\u001B[B", type: "ink" },
            { data: "c", type: "ink" },
        ],
    );
});

test("application input router preserves UTF-8 split across Buffer chunks", () => {
    const router = new TuiApplicationInputRouter();
    const bytes = Buffer.from("中文", "utf8");

    assert.deepEqual(router.push(bytes.subarray(0, 2)), []);
    assert.deepEqual(router.push(bytes.subarray(2)), [
        { data: "中", type: "ink" },
        { data: "文", type: "ink" },
    ]);
});
