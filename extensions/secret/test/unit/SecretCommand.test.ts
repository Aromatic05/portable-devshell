import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeSecretCommand } from "../../src/builtin/SecretCommand.ts";

function invocation(workingDirectory?: string, localOwner = true) {
    return {
        localOwner,
        requestId: "secret-test",
        signal: new AbortController().signal,
        ...(workingDirectory === undefined ? {} : { workingDirectory })
    };
}

test("Secret command resolves relative scan paths from caller cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-command-"));
    try {
        await writeFile(join(root, "secret.env"), "PASSWORD = 'real-secret-value-123'\n", "utf8");
        const result = await executeSecretCommand(["scan", "."], invocation(root));
        assert.equal(result.kind, "json");
        assert.deepEqual((result.value as { findings: unknown[] }).findings, [
            { line: 1, path: "secret.env", type: "generic_assignment" }
        ]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Secret command rejects non-owner invocation and missing cwd for relative paths", async () => {
    await assert.rejects(executeSecretCommand(["scan", "/tmp"], invocation(undefined, false)), /local owner/u);
    await assert.rejects(executeSecretCommand(["scan", "."], invocation()), /working directory/u);
});

test("Secret command honors cancellation without faulting the Extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-cancel-"));
    try {
        const controller = new AbortController();
        controller.abort(new Error("cancel secret scan"));
        await assert.rejects(executeSecretCommand(["scan", root], {
            localOwner: true,
            requestId: "secret-cancel",
            signal: controller.signal
        }), /cancel secret scan/u);

        const followUp = await executeSecretCommand(["help"], invocation(root));
        assert.equal(followUp.kind, "text");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
