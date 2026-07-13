import assert from "node:assert/strict";
import test from "node:test";

import {
    resolveControlRuntimeDirectory,
    resolveControlSocketPath
} from "@portable-devshell/shared";

test("control runtime path keeps the Unix socket layout unchanged", () => {
    assert.equal(
        resolveControlRuntimeDirectory("/run/user/1000", "linux", { USER: "alice" }),
        "/run/user/1000/portable-devshell"
    );
    assert.equal(
        resolveControlSocketPath("/run/user/1000", "linux", { USER: "alice" }),
        "/run/user/1000/portable-devshell/control.sock"
    );
});

test("control runtime path uses a per-user Windows named pipe", () => {
    assert.equal(
        resolveControlRuntimeDirectory(undefined, "win32", {
            LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
            USERNAME: "Alice Example"
        }),
        "C:\\Users\\alice\\AppData\\Local\\portable-devshell\\runtime"
    );
    assert.equal(
        resolveControlSocketPath(undefined, "win32", {
            LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
            USERNAME: "Alice Example"
        }),
        "\\\\.\\pipe\\portable-devshell-control-Alice-Example"
    );
});

test("Windows named pipe identity never contains path separators", () => {
    assert.equal(
        resolveControlSocketPath(undefined, "win32", {
            LOCALAPPDATA: "C:\\Temp",
            USERNAME: "DOMAIN\\alice/bob"
        }),
        "\\\\.\\pipe\\portable-devshell-control-DOMAIN-alice-bob"
    );
});
