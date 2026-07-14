import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkerDevshellHomeDirectory, resolveWorkerHomeDirectory } from "@portable-devshell/core";

test("worker home keeps HOME precedence on Unix-style environments", () => {
    assert.equal(
        resolveWorkerHomeDirectory({ HOME: "/home/alice", USERPROFILE: "C:\\Users\\alice" }),
        "/home/alice"
    );
});

test("worker home accepts USERPROFILE on Windows-style environments", () => {
    assert.equal(resolveWorkerHomeDirectory({ USERPROFILE: "C:\\Users\\alice" }), "C:\\Users\\alice");
});

test("worker devshell home honors PORTABLE_DEVSHELL_HOME", () => {
    assert.equal(
        resolveWorkerDevshellHomeDirectory({ HOME: "/home/alice", PORTABLE_DEVSHELL_HOME: "/srv/devshell" }),
        "/srv/devshell"
    );
});

test("worker devshell home defaults below the resolved user home", () => {
    assert.equal(resolveWorkerDevshellHomeDirectory({ HOME: "/home/alice" }), "/home/alice/.devshell");
});