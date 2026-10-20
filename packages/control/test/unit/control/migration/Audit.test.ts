import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { inspectAuditMigration, migrateAuditState } from "../../../../src/migration/Audit.js";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "../config/persistence/CrashProcess.ts";

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

for (const committed of [false, true]) {
    test(`Audit migration restart after crash ${committed ? "after first database commit resumes remaining Instances" : "inside schema transaction rolls back and retries"}`, async (t) => {
        const home = await createTestTempDirectory("audit-migration-crash");
        t.after(async () => await rm(home, { recursive: true, force: true }));
        const files = ["alpha-local", "beta-local"].map((name) => join(home, ".devshell", name, "control-worker", "audit.sqlite3"));
        for (const file of files) {
            await mkdir(dirname(file), { recursive: true });
            writeV2AuditDatabase(file);
            const database = new DatabaseSync(file);
            try {
                database.prepare("INSERT INTO audit_records (collection, occurred_at_ms, payload_bytes, payload, body, body_codec) VALUES (?, ?, ?, ?, ?, ?)")
                    .run("toolcall", 1234, 2, "{}", Buffer.from("audit-body"), "identity");
                database.prepare("INSERT INTO audit_metadata (key, value) VALUES (?, ?)").run("retained", "metadata");
            } finally {
                database.close();
            }
        }
        const module = new URL("../../../../src/migration/Audit.ts", import.meta.url).href;
        runPersistenceProcess(`
            import { DatabaseSync } from 'node:sqlite';
            const { home, committed } = JSON.parse(process.argv[1]);
            const exec = DatabaseSync.prototype.exec;
            DatabaseSync.prototype.exec = function(sql) {
                const result = exec.call(this, sql);
                if (committed ? sql === 'COMMIT' : sql.includes('PRAGMA user_version = 3')) {
                    process.kill(process.pid, 'SIGKILL');
                }
                return result;
            };
            const { migrateAuditState } = await import(${JSON.stringify(module)});
            await migrateAuditState(home);
            throw new Error('crash stage was not reached');
        `, { home, committed }, true);
        const first = new DatabaseSync(files[0]!);
        try {
            assert.equal(first.prepare("PRAGMA user_version").get()?.user_version, committed ? 3 : 2);
            assert.equal(first.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'state_records'").get()?.count, committed ? 1 : 0);
        } finally {
            first.close();
        }
        const second = new DatabaseSync(files[1]!, { readOnly: true });
        try {
            assert.equal(second.prepare("PRAGMA user_version").get()?.user_version, 2);
        } finally {
            second.close();
        }
        assert.equal(runPersistenceProcess(`
            const { migrateAuditState } = await import(${JSON.stringify(module)});
            process.stdout.write(JSON.stringify(await migrateAuditState(JSON.parse(process.argv[1]))));
        `, home), "true");
        for (const file of files) {
            const database = new DatabaseSync(file);
            try {
                assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 3);
                assert.equal(database.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
                assert.deepEqual({ ...database.prepare("SELECT * FROM audit_records").get() }, {
                    id: 1, collection: "toolcall", occurred_at_ms: 1234,
                    payload_bytes: 2, payload: "{}", body: new Uint8Array(Buffer.from("audit-body")), body_codec: "identity",
                });
                assert.equal(database.prepare("SELECT value FROM audit_metadata WHERE key = 'retained'").get()?.value, "metadata");
                database.prepare("INSERT INTO state_records (namespace, key, payload, payload_bytes) VALUES (?, ?, ?, ?)").run("context", "ctx-first", "{}", 2);
            } finally {
                database.close();
            }
        }
        assert.equal(runPersistenceProcess(`
            const { migrateAuditState } = await import(${JSON.stringify(module)});
            process.stdout.write(JSON.stringify(await migrateAuditState(JSON.parse(process.argv[1]))));
        `, home), "false");
        for (const file of files) {
            const database = new DatabaseSync(file, { readOnly: true });
            try {
                assert.equal(database.prepare("SELECT count(*) AS count FROM state_records WHERE namespace = 'context' AND key = 'ctx-first'").get()?.count, 1);
                assert.equal(database.prepare("SELECT count(*) AS count FROM audit_records").get()?.count, 1);
            } finally {
                database.close();
            }
        }
    });
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
