import assert from "node:assert/strict";
import test from "node:test";

import { removeControlIpcEndpoint } from "@portable-devshell/control";

test("Windows named pipes are not passed to filesystem unlink", async () => {
    let calls = 0;
    await removeControlIpcEndpoint("\\\\.\\pipe\\portable-devshell-control-alice", async () => {
        calls += 1;
    });
    assert.equal(calls, 0);
});

test("Unix socket files are removed through filesystem unlink", async () => {
    const paths: string[] = [];
    await removeControlIpcEndpoint("/run/user/1000/portable-devshell/control.sock", async (path) => {
        paths.push(path);
    });
    assert.deepEqual(paths, ["/run/user/1000/portable-devshell/control.sock"]);
});
