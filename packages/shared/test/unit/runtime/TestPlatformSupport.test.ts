import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { rm, realpath } from "node:fs/promises";
import test from "node:test";

import { createCanonicalTestDirectory, createTestIpcPath } from "../../../../../test/TestPlatformSupport.ts";

test("Darwin test IPC paths stay below the conservative Unix socket limit", () => {
    const longTemporaryDirectory = `/var/folders/${"x".repeat(180)}/T`;
    const socketPath = createTestIpcPath(
        "portable-devshell-client-connection-with-a-long-name",
        longTemporaryDirectory,
        "darwin"
    );

    assert.match(socketPath, /^\/tmp\/pds-/u);
    assert.ok(Buffer.byteLength(socketPath, "utf8") <= 100, socketPath);
    assert.equal(socketPath.includes(longTemporaryDirectory), false);
});

test("Linux test IPC paths remain inside the requested directory", () => {
    assert.equal(
        createTestIpcPath("client-connection", "/tmp/runtime", "linux"),
        "/tmp/runtime/client-connection.sock"
    );
});

test("Windows test IPC paths use a named pipe", () => {
    assert.equal(
        createTestIpcPath("client-connection", "C:\\temp", "win32").startsWith(
            "\\\\.\\pipe\\portable-devshell-test-client-connection-"
        ),
        true
    );
});

test("canonical test directories resolve platform aliases", async (t) => {
    const directory = await createCanonicalTestDirectory("portable-devshell-canonical-");
    t.after(async () => await rm(directory, { force: true, recursive: true }));

    assert.equal(directory, await realpath(directory));
});
