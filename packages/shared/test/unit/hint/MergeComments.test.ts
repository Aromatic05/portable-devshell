import assert from "node:assert/strict";
import test from "node:test";

import {
    diagnosticHint,
    errorHint,
    mergeComments
} from "@portable-devshell/shared";

test("clean success produces only user comments in order", () => {
    assert.deepEqual(
        mergeComments(["first", "second"], []),
        ["first", "second"]
    );
});

test("user comments precede hints and keep their order", () => {
    const hints = [errorHint("bash.nonZeroExit", "x"), diagnosticHint("tmux.taskRunning", "y")];
    assert.deepEqual(
        mergeComments(["alpha", "beta"], hints),
        [
            "alpha",
            "beta",
            "Error hint [bash.nonZeroExit]: x",
            "Diagnostic hint [tmux.taskRunning]: y"
        ]
    );
});

test("empty strings are removed while non-empty whitespace comments are preserved verbatim", () => {
    assert.deepEqual(
        mergeComments(["keep", "", "   "], []),
        ["keep", "   "]
    );
});

test("exact duplicate user comments are collapsed", () => {
    assert.deepEqual(
        mergeComments(["same", "same", "other"], []),
        ["same", "other"]
    );
});

test("hints with the same stable code are deduplicated", () => {
    const hints = [
        errorHint("bash.nonZeroExit", "first"),
        errorHint("bash.nonZeroExit", "second")
    ];
    assert.deepEqual(
        mergeComments([], hints),
        ["Error hint [bash.nonZeroExit]: first"]
    );
});

test("hints with different codes are both kept even when text overlaps", () => {
    const hints = [
        errorHint("bash.nonZeroExit", "retry after fixing"),
        errorHint("bash.timeout", "retry after fixing")
    ];
    assert.equal(mergeComments([], hints).length, 2);
});

test("a hint colliding with a user comment by exact string is not duplicated", () => {
    const collision = "Error hint [bash.nonZeroExit]: x";
    assert.deepEqual(
        mergeComments([collision], [errorHint("bash.nonZeroExit", "x")]),
        [collision]
    );
});

test("merge does not mutate the input arrays", () => {
    const comments = ["a"];
    const hints = [errorHint("bash.nonZeroExit", "x")];
    const snapshot = { comments: [...comments], hints: [...hints] };
    mergeComments(comments, hints);
    assert.deepEqual(comments, snapshot.comments);
    assert.deepEqual(hints, snapshot.hints);
});

test("empty inputs return an empty array without hints or comments", () => {
    assert.deepEqual(mergeComments([], []), []);
});
