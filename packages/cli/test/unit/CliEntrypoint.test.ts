import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isCliEntrypoint } from "../../dist/cli/CliEntrypoint.js";

test("isCliEntrypoint compares the module URL with the platform-native argv path", () => {
    const argvPath = process.argv[1] ?? process.execPath;
    const moduleUrl = pathToFileURL(argvPath).href;

    assert.equal(isCliEntrypoint(moduleUrl, argvPath), true);
    assert.equal(isCliEntrypoint("file:///different-entry.js", argvPath), false);
    assert.equal(isCliEntrypoint(moduleUrl, undefined), false);
});
