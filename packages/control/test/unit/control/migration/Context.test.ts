import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
    inspectContextMigration,
    migrateContextState,
} from "../../../../src/migration/Context.js";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "../config/persistence/CrashProcess.ts";

test("Context Registry v1 is preflighted without modification and migrated exactly once", async () => {
    const home = await mkdtemp(join(tmpdir(), "pds-context-migration-"));
    const file = join(home, ".devshell", "control", "contexts.json");
    const environment = { PORTABLE_DEVSHELL_HOME: join(home, ".devshell") };
    const date = new Date().toISOString();
    const legacy = {
        contexts: [{
            createdAt: date,
            ctxId: "ctx-legacy-upgrade",
            environments: [{ instance: "old-host", workspace: "/workspace" }],
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            instance: "old-host",
            lastAccessedAt: date,
            principal: "upgrade-principal",
            status: "active",
            workspace: "/workspace",
        }],
        version: 1,
    };
    try {
        await mkdir(dirname(file), { recursive: true });
        const before = JSON.stringify(legacy);
        await writeFile(file, before, "utf8");
        const inspection = await inspectContextMigration(home, environment);
        assert.equal(inspection.required, true);
        assert.equal(await readFile(file, "utf8"), before);
        assert.equal(await migrateContextState(home, environment), true);
        const upgraded = JSON.parse(await readFile(file, "utf8"));
        assert.equal(upgraded.version, 2);
        assert.equal(upgraded.contexts[0].ctxId, legacy.contexts[0].ctxId);
        assert.equal(upgraded.contexts[0].principal, legacy.contexts[0].principal);
        assert.deepEqual(upgraded.contexts[0].environments, legacy.contexts[0].environments);
        assert.equal("instance" in upgraded.contexts[0], false);
        assert.equal("workspace" in upgraded.contexts[0], false);
        assert.equal((await inspectContextMigration(home, environment)).required, false);
        assert.equal(await migrateContextState(home, environment), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

for (const published of [false, true]) {
    test(`Context migration restart after crash ${published ? "after" : "before"} registry rename preserves records and is idempotent`, async (t) => {
        const home = await createTestTempDirectory("context-migration-crash");
        t.after(async () => await rm(home, { recursive: true, force: true }));
        const file = join(home, ".devshell", "control", "contexts.json");
        const contexts = ["first", "second"].map((name) => ({
            ctxId: `ctx-${name}`,
            principal: `principal-${name}`,
            instance: "old-host",
            workspace: "/workspace",
            environments: [
                { instance: "old-host", workspace: "/workspace" },
                { instance: "other-host", workspace: "/other" },
            ],
            createdAt: "2026-01-01T00:00:00.000Z",
            lastAccessedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            status: "active",
        }));
        await mkdir(dirname(file), { recursive: true });
        const before = JSON.stringify({ contexts, version: 1 });
        await writeFile(file, before);
        const module = new URL("../../../../src/migration/Context.ts", import.meta.url).href;
        runPersistenceProcess(`
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, file, published } = JSON.parse(process.argv[1]);
            const rename = fs.rename;
            fs.rename = async (source, target) => {
                if (target === file && !published) process.kill(process.pid, 'SIGKILL');
                await rename(source, target);
                if (target === file && published) process.kill(process.pid, 'SIGKILL');
            };
            syncBuiltinESMExports();
            const { migrateContextState } = await import(${JSON.stringify(module)});
            await migrateContextState(home);
            throw new Error('crash stage was not reached');
        `, { home, file, published }, true);
        const interrupted = await readFile(file, "utf8");
        assert.equal(JSON.parse(interrupted).version, published ? 2 : 1);
        assert.equal(await inspectContextMigration(home).then((result) => result.required), !published);
        assert.equal(runPersistenceProcess(`
            const { migrateContextState } = await import(${JSON.stringify(module)});
            process.stdout.write(JSON.stringify(await migrateContextState(JSON.parse(process.argv[1]))));
        `, home), JSON.stringify(!published));
        const migrated = await readFile(file, "utf8");
        assert.deepEqual(JSON.parse(migrated), {
            version: 2,
            contexts: contexts.map(({ instance, workspace, ...record }) => record),
        });
        assert.equal(runPersistenceProcess(`
            const { migrateContextState } = await import(${JSON.stringify(module)});
            process.stdout.write(JSON.stringify(await migrateContextState(JSON.parse(process.argv[1]))));
        `, home), "false");
        assert.equal(await readFile(file, "utf8"), migrated);
    });
}

test("Invalid Context v1 and unsupported schema versions are rejected before rewriting", async () => {
    const home = await mkdtemp(join(tmpdir(), "pds-context-migration-"));
    const file = join(home, ".devshell", "control", "contexts.json");
    try {
        await mkdir(dirname(file), { recursive: true });
        for (const data of [
            { contexts: [{ ctxId: "ctx-missing-environments" }], version: 1 },
            { contexts: [], version: 3 },
        ]) {
            const source = JSON.stringify(data);
            await writeFile(file, source);
            await assert.rejects(inspectContextMigration(home), /missing environments|Unsupported Context/);
            await assert.rejects(migrateContextState(home), /missing environments|Unsupported Context/);
            assert.equal(await readFile(file, "utf8"), source);
        }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
