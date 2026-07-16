import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isCliEntrypoint } from "../../dist/CliEntrypoint.js";

test("isCliEntrypoint compares the module URL with the platform-native argv path", () => {
    const argvPath = process.argv[1] ?? process.execPath;
    const moduleUrl = pathToFileURL(argvPath).href;

    assert.equal(isCliEntrypoint(moduleUrl, argvPath), true);
    assert.equal(isCliEntrypoint("file:///different-entry.js", argvPath), false);
    assert.equal(isCliEntrypoint(moduleUrl, undefined), false);
});

test(
    "isCliEntrypoint resolves a Unix command symlink before comparing paths",
    { skip: process.platform === "win32" },
    async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "portable-devshell-cli-entry-"));
        const commandPath = resolve(directory, "devshell");

        try {
            await symlink(process.execPath, commandPath);
            assert.equal(isCliEntrypoint(pathToFileURL(process.execPath).href, commandPath), true);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    }
);