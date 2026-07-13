import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkerHomeDirectory } from "@portable-devshell/core";

test("worker home keeps HOME precedence on Unix-style environments", () => {
    assert.equal(
        resolveWorkerHomeDirectory({ HOME: "/home/alice", USERPROFILE: "C:\\Users\\alice" }),
        "/home/alice"
    );
});

test("worker home accepts USERPROFILE on Windows-style environments", () => {
    assert.equal(resolveWorkerHomeDirectory({ USERPROFILE: "C:\\Users\\alice" }), "C:\\Users\\alice");
});
