import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
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
            files: [file],
            required: true,
        });
        assert.equal(await migrateAuditState(home, environment), true);
        assert.deepEqual(await inspectAuditMigration(home, environment), {
            files: [file],
            required: false,
        });
        assert.equal(await migrateAuditState(home, environment), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("Audit migration rejects symlinked worker directories before opening their database", async () => {
    const home = await mkdtemp(join(tmpdir(), "pds-audit-symlink-"));
    try {
        const instance = join(home, ".devshell", "old-instance");
        const outside = join(home, "unrelated");
        await mkdir(instance, { recursive: true });
        await mkdir(outside);
        await symlink(outside, join(instance, "control-worker"), "dir");
        await assert.rejects(inspectAuditMigration(home), /not a plain directory/u);
        await assert.rejects(migrateAuditState(home), /not a plain directory/u);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("Audit migration rejects symlinked database files", async () => {
    const home = await mkdtemp(join(tmpdir(), "pds-audit-file-link-"));
    try {
        const directory = join(home, ".devshell", "old-instance", "control-worker");
        await mkdir(directory, { recursive: true });
        await symlink(join(home, "unrelated.sqlite3"), join(directory, "audit.sqlite3"), "file");
        await assert.rejects(inspectAuditMigration(home), /not a plain file/u);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
