import assert from "node:assert/strict";
import test from "node:test";

import { chromiumTestOptions, realWorkerTestOptions } from "../../../../test/TestPlatformSupport.ts";

test("real Worker test gate fails closed in CI when the Worker is unavailable", () => {
    assert.throws(() =>
        realWorkerTestOptions(undefined, { CI: "true" } as NodeJS.ProcessEnv),
    );
});

test("real Worker test gate may skip a missing local Worker", () => {
    const options = realWorkerTestOptions(undefined, {} as NodeJS.ProcessEnv);
    assert.equal(typeof options.skip, "string");
});

test("real Worker test gate executes when the Worker is available", () => {
    const options = realWorkerTestOptions(
        "/tmp/devshell-worker",
        { CI: "true" } as NodeJS.ProcessEnv,
    );
    assert.equal(options.skip, false);
});

test("Chromium test gate fails closed when browser acceptance is required", () => {
    assert.throws(() =>
        chromiumTestOptions(undefined, {
            PORTABLE_DEVSHELL_REQUIRE_CHROMIUM: "1",
        } as NodeJS.ProcessEnv),
    );
});

test("Chromium test gate may skip a target that does not own browser acceptance", () => {
    const options = chromiumTestOptions(undefined, {} as NodeJS.ProcessEnv);
    assert.equal(typeof options.skip, "string");
});

test("Chromium test gate executes when Chromium is available", () => {
    const options = chromiumTestOptions(
        "/tmp/chromium",
        { PORTABLE_DEVSHELL_REQUIRE_CHROMIUM: "1" } as NodeJS.ProcessEnv,
    );
    assert.equal(options.skip, false);
});
