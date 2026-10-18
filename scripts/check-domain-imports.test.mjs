import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("domain import checker rejects core domain private imports and toolcall-to-approval imports", async () => {
    const auditFixture = await mkdtemp(
        join(root, "packages/core/src/audit/.domain-check-"),
    );
    const toolcallFixture = await mkdtemp(
        join(root, "packages/core/src/toolcall/.domain-check-"),
    );

    try {
        await writeFile(
            join(auditFixture, "Rejects.ts"),
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
        assert.match(result.stderr, /audit-uses-domain-public-entries/u);
        assert.match(result.stderr, /toolcall-does-not-depend-on-worker-or-approval/u);
    } finally {
        await Promise.all([
            rm(auditFixture, { force: true, recursive: true }),
            rm(toolcallFixture, { force: true, recursive: true }),
        ]);
    }
});

test("instance may compose domain runtimes and public hooks but not import private implementations", async () => {
    const instanceFixture = await mkdtemp(
        join(root, "packages/core/src/instance/.domain-check-"),
    );

    try {
        await writeFile(
            join(instanceFixture, "Allowed.ts"),
            [
                'import { createTaskRuntime } from "../../task/index.js";',
                'import { installTodoTools } from "../../task/Public.js";',
                'import type { TaskRuntime } from "../../task/Api.js";',
                "",
            ].join("\n"),
        );
        await writeFile(
            join(instanceFixture, "Rejected.ts"),
            [
                'import { installTodoTools } from "../../task/todo/tool/Runtime.js";',
                'import type { TaskRuntime } from "../../task/index.js";',
                "",
            ].join("\n"),
        );

        const result = spawnSync(
            process.execPath,
            [join(root, "scripts/check-domain-imports.mjs")],
            { cwd: root, encoding: "utf8" },
        );
        assert.equal(result.status, 1);
        const violations = result.stderr.trim().split("\n");
        assert.equal(violations.length, 2);
        assert.ok(violations.every((line) =>
            line.includes("instance-uses-domain-public-entries") &&
            line.includes("Rejected.ts"),
        ));
        assert.doesNotMatch(result.stderr, /Allowed\.ts/u);
    } finally {
        await rm(instanceFixture, { force: true, recursive: true });
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
