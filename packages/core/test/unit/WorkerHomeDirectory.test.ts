import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkerDevshellHomeDirectory, resolveWorkerHomeDirectory } from "@portable-devshell/core/testing";

test("worker home keeps HOME precedence on Unix-style environments", () => {
    assert.equal(
        resolveWorkerHomeDirectory(
            { HOME: "/home/alice", USERPROFILE: "C:\\Users\\alice" },
            "linux"
        ),
        "/home/alice"
    );
});

test("worker home keeps USERPROFILE precedence on Windows", () => {
    assert.equal(
        resolveWorkerHomeDirectory(
            { HOME: "C:\\msys64\\home\\alice", USERPROFILE: "C:\\Users\\alice" },
            "win32"
        ),
        "C:\\Users\\alice"
    );
});

test("worker home reconstructs HOMEDRIVE and HOMEPATH on Windows", () => {
    assert.equal(
        resolveWorkerHomeDirectory({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\alice" }, "win32"),
        "D:\\Users\\alice"
    );
});

test("worker devshell home honors PORTABLE_DEVSHELL_HOME", () => {
    assert.equal(
        resolveWorkerDevshellHomeDirectory({ HOME: "/home/alice", PORTABLE_DEVSHELL_HOME: "/srv/devshell" }),
        "/srv/devshell"
    );
});

test("worker devshell home uses target-platform path semantics", () => {
    assert.equal(
        resolveWorkerDevshellHomeDirectory({ USERPROFILE: "C:\\Users\\alice" }, "win32"),
        "C:\\Users\\alice\\.devshell"
    );
    assert.equal(
        resolveWorkerDevshellHomeDirectory({ HOME: "/home/alice" }, "linux"),
        "/home/alice/.devshell"
    );
});
