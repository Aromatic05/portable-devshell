import assert from "node:assert/strict";
import test from "node:test";

import { renderCliError } from "../../src/render/CliRenderError.ts";

test("renderCliError preserves diagnostic details and verbose cause chain", () => {
    const error = {
        causeBody: {
            code: "core.providerFailed",
            message: "cause-fixture",
            retryable: false
        },
        code: "core.workerStartFailed",
        details: {
            commandDisplay: "command-fixture",
            cwd: "/cwd-fixture",
            exitCode: 197,
            operation: "operation-fixture",
            provider: "provider-fixture",
            stderrTail: "stderr-fixture\n"
        },
        message: "top-level-fixture"
    };

    const rendered = renderCliError(error);
    for (const value of [
        "top-level-fixture",
        "provider-fixture",
        "operation-fixture",
        "command-fixture",
        "/cwd-fixture",
        "197",
        "stderr-fixture"
    ]) {
        assert.equal(rendered.includes(value), true, value);
    }
    const verbose = renderCliError(error, { verbose: true });
    assert.equal(verbose.includes("core.providerFailed"), true);
    assert.equal(verbose.includes("cause-fixture"), true);
});
