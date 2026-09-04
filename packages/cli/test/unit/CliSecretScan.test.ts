import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanSecrets } from "../../src/command/secret/CliCommandSecretScan.ts";

test("secret scan reports locations without returning secret values", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-scan-"));
    try {
        const token = "ghp_1234567890123456789012345678901234567890";
        await writeFile(join(root, "visible.txt"), `const value = '${token}';\n`, "utf8");

        const result = await scanSecrets({ cwd: root, limit: 20 });

        assert.deepEqual(result.findings, [{ line: 1, path: "visible.txt", type: "github_token" }]);
        assert.equal(JSON.stringify(result).includes(token), false);
        assert.equal(result.truncated, false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("secret scan respects ignore files and skips obvious placeholders", async (t) => {
    if (spawnSync("rg", ["--version"]).error !== undefined) {
        t.skip("ripgrep unavailable");
    }
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-ignore-"));
    try {
        await mkdir(join(root, ".git"));
        await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
        await writeFile(
            join(root, "ignored.txt"),
            "TOKEN = 'ghp_1234567890123456789012345678901234567890'\n",
            "utf8"
        );
        await writeFile(join(root, "placeholder.env"), "SECRET = '${EXAMPLE:-dev-change-me}'\n", "utf8");
        await writeFile(join(root, "visible.env"), "API_KEY = 'realistic-live-value-123'\n", "utf8");

        const result = await scanSecrets({ cwd: root, limit: 20 });
        const paths = result.findings.map((finding) => finding.path);

        assert.deepEqual(paths, ["visible.env"]);
        assert.equal(result.findings[0]?.type, "generic_assignment");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("secret scan applies glob and result limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-limit-"));
    try {
        await writeFile(join(root, "a.env"), "PASSWORD = 'real-secret-value-a'\n", "utf8");
        await writeFile(join(root, "b.env"), "PASSWORD = 'real-secret-value-b'\n", "utf8");
        await writeFile(join(root, "c.txt"), "PASSWORD = 'real-secret-value-c'\n", "utf8");

        const result = await scanSecrets({ cwd: root, glob: "*.env", limit: 1 });

        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0]?.path.endsWith(".env"), true);
        assert.equal(result.truncated, true);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
