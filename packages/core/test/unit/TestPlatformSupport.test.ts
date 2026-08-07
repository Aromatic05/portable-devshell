import assert from "node:assert/strict";
import test from "node:test";

import { realWorkerTestOptions } from "../../../../test/TestPlatformSupport.ts";

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
