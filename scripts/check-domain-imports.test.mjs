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

test("TUI State and Interaction cannot depend on View implementations", async () => {
    const stateFixture = await mkdtemp(
        join(root, "packages/tui/src/state/.domain-check-"),
    );
    const interactionFixture = await mkdtemp(
        join(root, "packages/tui/src/interaction/.domain-check-"),
    );

    try {
        await writeFile(
            join(stateFixture, "Allowed.ts"),
            [
                'import type { TuiDomainReader } from "../../app/control/Reader.js";',
                'import { wrapTerminalText } from "../../terminal/Public.js";',
                "",
            ].join("\n"),
        );
        await writeFile(
            join(stateFixture, "Rejected.ts"),
            [
                'import { projectAuditContexts } from "../../view/page/activity/audit/List.js";',
                'import type { TuiDomainReader } from "../../view/domain/Reader.js";',
                "",
            ].join("\n"),
        );
        await writeFile(
            join(interactionFixture, "Allowed.ts"),
            'import { wrapTerminalText } from "../../terminal/Public.js";\n',
        );
        await writeFile(
            join(interactionFixture, "Rejected.ts"),
            'import { selectMainScreenModel } from "../../view/projection/View.js";\n',
        );

        const result = spawnSync(
            process.execPath,
            [join(root, "scripts/check-domain-imports.mjs")],
            { cwd: root, encoding: "utf8" },
        );
        assert.equal(result.status, 1);
        const violations = result.stderr.trim().split("\n");
        assert.equal(violations.length, 3);
        assert.ok(violations.every((line) => line.includes("Rejected.ts")));
        assert.equal(
            violations.filter((line) => line.includes("tui-state-does-not-depend-on-view")).length,
            2,
        );
        assert.equal(
            violations.filter((line) => line.includes("tui-interaction-does-not-depend-on-view")).length,
            1,
        );
        assert.doesNotMatch(result.stderr, /Allowed\.ts/u);
    } finally {
        await Promise.all([
            rm(stateFixture, { force: true, recursive: true }),
            rm(interactionFixture, { force: true, recursive: true }),
        ]);
    }
});

test("Extension Config consumers use type and runtime domain entries", async () => {
    const fixture = await mkdtemp(
        join(root, "packages/control/src/extension/.domain-check-"),
    );
    try {
        await writeFile(
            join(fixture, "Allowed.ts"),
            [
                'import { ConfigChangeHub } from "../../config/Public.js";',
                'import type { ConfigRegistry } from "../../config/Api.js";',
                "",
            ].join("\n"),
        );
        await writeFile(
            join(fixture, "Rejected.ts"),
            [
                'import { ConfigChangeHub } from "../../config/change/Config.js";',
                'import type { ConfigRegistry } from "../../config/Public.js";',
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
            line.includes("extension-uses-config-public-entries") &&
            line.includes("Rejected.ts"),
        ));
        assert.doesNotMatch(result.stderr, /Allowed\.ts/u);
    } finally {
        await rm(fixture, { force: true, recursive: true });
    }
});

test("Web state and domain sessions stay independent of presentation", async () => {
    const state = await mkdtemp(
        join(root, "packages/web/src/state/.domain-check-"),
    );
    const domainFixture = await mkdtemp(
        join(root, "packages/web/src/app/domain/.domain-check-"),
    );
    try {
        await writeFile(
            join(state, "Allowed.ts"),
            'import type { WebDomainSession } from "../../app/domain/Session.js";\n',
        );
        await writeFile(
            join(state, "Rejected.ts"),
            'import { todoSummaries } from "../../view/ReadModel.js";\n',
        );
        await writeFile(
            join(domainFixture, "Rejected.ts"),
            'import { todoSummaries } from "../../../view/ReadModel.js";\n',
        );
        const result = spawnSync(
            process.execPath,
            [join(root, "scripts/check-domain-imports.mjs")],
            { cwd: root, encoding: "utf8" },
        );
        assert.equal(result.status, 1);
        const violations = result.stderr.trim().split("\n");
        assert.equal(violations.length, 2);
        assert.match(result.stderr, /web-state-does-not-depend-on-view/u);
        assert.match(result.stderr, /web-domain-does-not-depend-on-view/u);
        assert.doesNotMatch(result.stderr, /Allowed\.ts/u);
    } finally {
        await Promise.all([
            rm(state, { force: true, recursive: true }),
            rm(domainFixture, { force: true, recursive: true }),
        ]);
    }
});

test("Control Server uses Domain Api/Public entries except Overview composition", async () => {
    const fixture = await mkdtemp(
        join(root, "packages/control/src/server/.domain-check-"),
    );
    try {
        await writeFile(
            join(fixture, "Allowed.ts"),
            [
                'import { createConfigRouteModule } from "../../config/Public.js";',
                'import type { ConfigChangeHub } from "../../config/Api.js";',
                'import { createOperationalOverviewRuntime } from "../../overview/index.js";',
                "",
            ].join("\n"),
        );
        await writeFile(
            join(fixture, "Rejected.ts"),
            [
                'import { ConfigChangeHub } from "../../config/change/Config.js";',
                'import type { TuiPagePort } from "../../extension/api/point/tui/Service.js";',
                'import { createOperationalOverviewRouteModule } from "../../overview/Route.js";',
                'import type { ConfigChangeHub } from "../../config/Public.js";',
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
        assert.equal(violations.length, 4);
        assert.ok(violations.every((line) =>
            line.includes("server-uses-control-domain-public-entries") &&
            line.includes("Rejected.ts"),
        ));
        assert.doesNotMatch(result.stderr, /Allowed\.ts/u);
    } finally {
        await rm(fixture, { force: true, recursive: true });
    }
});
