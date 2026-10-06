import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("domain import checker rejects instance-to-task and toolcall-to-approval imports", async () => {
    const instanceFixture = await mkdtemp(
        join(root, "packages/core/src/instance/.domain-check-"),
    );
    const toolcallFixture = await mkdtemp(
        join(root, "packages/core/src/toolcall/.domain-check-"),
    );

    try {
        await writeFile(
            join(instanceFixture, "Rejects.ts"),
            'import "../../task/index.js";\n',
        );
        await writeFile(
            join(toolcallFixture, "Rejects.ts"),
            'import "../../approval/Public.js";\n',
        );

        const result = spawnSync(
            process.execPath,
            [join(root, "scripts/check-domain-imports.mjs")],
            { cwd: root, encoding: "utf8" },
        );

        assert.equal(result.status, 1);
        assert.match(result.stderr, /instance-does-not-depend-on-business-domains/u);
        assert.match(result.stderr, /toolcall-does-not-depend-on-worker-or-approval/u);
    } finally {
        await Promise.all([
            rm(instanceFixture, { force: true, recursive: true }),
            rm(toolcallFixture, { force: true, recursive: true }),
        ]);
    }
});

test("domain import checker rejects Control domain private imports", async () => {
    const extensionFixture = await mkdtemp(
        join(root, "packages/control/src/extension/.domain-check-"),
    );

    try {
        await writeFile(
            join(extensionFixture, "Rejects.ts"),
            'import "../../artifact/Archive.js";\n',
        );

        const result = spawnSync(
            process.execPath,
            [join(root, "scripts/check-domain-imports.mjs")],
            { cwd: root, encoding: "utf8" },
        );

        assert.equal(result.status, 1);
        assert.match(
            result.stderr,
            /extension-uses-control-domain-public-entries/u,
        );
    } finally {
        await rm(extensionFixture, { force: true, recursive: true });
    }
});
