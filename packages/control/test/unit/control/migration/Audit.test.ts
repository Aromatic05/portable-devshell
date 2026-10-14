import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { inspectAuditMigration, migrateAuditState } from "../../../../src/migration/Audit.js";

function writeV2AuditDatabase(filePath: string): void {
    const database = new DatabaseSync(filePath);
    try {
        database.exec([
            "CREATE TABLE audit_records (",
            "id INTEGER PRIMARY KEY AUTOINCREMENT,",
            "collection TEXT NOT NULL,",
            "occurred_at_ms INTEGER NOT NULL,",
            "payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),",
            "payload TEXT NOT NULL,",
            "body BLOB, body_codec TEXT",
            ") STRICT;",
            "CREATE TABLE audit_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
            "PRAGMA user_version = 2;",
        ].join(" "));
    } finally {
        database.close();
    }
}

test("Audit migration uses the same configured home as Context migration", async () => {
    const home = await mkdtemp(join(tmpdir(), "pds-audit-discovery-"));
    try {
        const file = join(home, ".devshell", "old-instance", "control-worker", "audit.sqlite3");
        await mkdir(dirname(file), { recursive: true });
        writeV2AuditDatabase(file);
        const environment = { PORTABLE_DEVSHELL_HOME: join(home, "ignored-home") };
        assert.deepEqual(await inspectAuditMigration(home, environment), {
            deferredFiles: [],
            files: [file],
            required: true,
        });
        assert.equal(await migrateAuditState(home, environment), true);
        assert.deepEqual(await inspectAuditMigration(home, environment), {
            deferredFiles: [],
            files: [file],
            required: false,
        });
        assert.equal(await migrateAuditState(home, environment), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("a damaged historical Audit database does not block migration of another Instance", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "pds-audit-partial-"));
    t.after(async () => await rm(home, { recursive: true, force: true }));
    const good = join(home, ".devshell", "good-local", "control-worker", "audit.sqlite3");
    const bad = join(home, ".devshell", "retired-local", "control-worker", "audit.sqlite3");
    await mkdir(dirname(good), { recursive: true });
    await mkdir(dirname(bad), { recursive: true });
    writeV2AuditDatabase(good);
    await writeFile(bad, "not a SQLite database");
    const warning = t.mock.method(console, "warn", () => undefined);
    assert.deepEqual(await inspectAuditMigration(home), { deferredFiles: [bad], files: [good], required: true });
    assert.equal(await migrateAuditState(home), true);
    const migrated = new DatabaseSync(good, { readOnly: true });
    try {
        assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, 3);
    } finally {
        migrated.close();
    }
    assert.equal(await readFile(bad, "utf8"), "not a SQLite database");
    assert.ok(warning.mock.callCount() >= 2);
});

test("Audit migration skips symlinked worker directories without following them", async () => {
    const home = await mkdtemp(join(tmpdir(), "pds-audit-symlink-"));
    try {
        const instance = join(home, ".devshell", "old-instance");
        const outside = join(home, "unrelated");
        await mkdir(instance, { recursive: true });
        await mkdir(outside);
        await symlink(outside, join(instance, "control-worker"), "dir");
        assert.deepEqual(await inspectAuditMigration(home), {
            deferredFiles: [join(instance, "control-worker")], files: [], required: false,
        });
        assert.equal(await migrateAuditState(home), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("Audit migration skips symlinked database files without opening them", async () => {
    const home = await mkdtemp(join(tmpdir(), "pds-audit-file-link-"));
    try {
        const directory = join(home, ".devshell", "old-instance", "control-worker");
        await mkdir(directory, { recursive: true });
        await symlink(join(home, "unrelated.sqlite3"), join(directory, "audit.sqlite3"), "file");
        assert.deepEqual(await inspectAuditMigration(home), {
            deferredFiles: [join(directory, "audit.sqlite3")], files: [], required: false,
        });
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
