import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliMain } from "../../src/CliMain.ts";

test("secret scan runs locally without negotiating Control", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-cli-"));
    const stdout = buffer();
    const stderr = buffer();
    let helloCalls = 0;
    try {
        await writeFile(join(root, "secret.env"), "PASSWORD = 'real-secret-value-123'\n", "utf8");
        const cli = new CliMain({
            createCliClients: () => ({
                close() {},
                async hello() {
                    helloCalls += 1;
                    throw new Error("secret scan must not contact Control");
                }
            } as never),
            stderr,
            stdout
        });

        assert.equal(await cli.run(["secret", "scan", root]), 0);
        assert.equal(helloCalls, 0);
        assert.equal(stderr.flush(), "");
        const result = JSON.parse(stdout.flush()) as { findings: Array<{ path: string; type: string }> };
        assert.deepEqual(result.findings, [{ line: 1, path: "secret.env", type: "generic_assignment" }]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

function buffer(): { flush(): string; write(chunk: string): void } {
    let content = "";
    return {
        flush() {
            const value = content;
            content = "";
            return value;
        },
        write(chunk: string) {
            content += chunk;
        }
    };
}
