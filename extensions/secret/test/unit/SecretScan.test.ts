import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanSecrets } from "../../src/builtin/SecretScan.ts";

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

test("secret scan respects ignore files and skips obvious placeholders", async () => {
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

test("secret scan respects ignored directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-ignore-directory-"));
    try {
        await mkdir(join(root, "ignored"));
        await writeFile(join(root, ".gitignore"), "ignored/\n", "utf8");
        await writeFile(join(root, "ignored/secret.env"), "PASSWORD = 'ignored-secret-value'\n", "utf8");
        await writeFile(join(root, "visible.env"), "PASSWORD = 'visible-secret-value'\n", "utf8");
        const result = await scanSecrets({ cwd: root, limit: 20 });
        assert.deepEqual(result.findings.map((finding) => finding.path), ["visible.env"]);
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


test("secret scan honors nested ignore scopes and negation", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-secret-nested-ignore-"));
    try {
        await mkdir(join(root, "nested"));
        await writeFile(join(root, ".gitignore"), "*.env\n!keep.env\n", "utf8");
        await writeFile(join(root, "drop.env"), "PASSWORD = 'drop-secret-value'\n", "utf8");
        await writeFile(join(root, "keep.env"), "PASSWORD = 'keep-secret-value'\n", "utf8");
        await writeFile(join(root, "nested", ".ignore"), "local.txt\n", "utf8");
        await writeFile(join(root, "nested", "local.txt"), "PASSWORD = 'nested-secret-value'\n", "utf8");
        await writeFile(join(root, "nested", "visible.txt"), "PASSWORD = 'visible-secret-value'\n", "utf8");
        const result = await scanSecrets({ cwd: root, limit: 20 });
        assert.deepEqual(result.findings.map((finding) => finding.path), ["keep.env", "nested/visible.txt"]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
