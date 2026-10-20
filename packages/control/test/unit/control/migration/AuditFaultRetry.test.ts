import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { inspectAuditMigration, migrateAuditState } from "../../../../src/migration/Audit.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "../config/persistence/CrashProcess.ts";

const moduleUrl = new URL("../../../../src/migration/Audit.ts", import.meta.url).href;

for (const boundary of ["version-update", "commit"] as const) {
    test(`Audit ${boundary} failure rolls back one database, migrates its neighbor, and retries without losing rows`, async (t) => {
        const home = await createTestTempDirectory("audit-fault-retry");
        t.after(() => rm(home, { recursive: true, force: true }));
        const files = ["alpha-local", "beta-local"].map((name) => join(home, ".devshell", name, "control-worker", "audit.sqlite3"));
        for (const file of files) {
            await mkdir(dirname(file), { recursive: true });
            const database = new DatabaseSync(file);
            try {
                database.exec(`
                    CREATE TABLE audit_records (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL,
                        occurred_at_ms INTEGER NOT NULL, payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                        payload TEXT NOT NULL, body BLOB, body_codec TEXT
                    ) STRICT;
                    CREATE TABLE audit_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
                    PRAGMA user_version = 2;
                `);
                database.prepare("INSERT INTO audit_records (collection, occurred_at_ms, payload_bytes, payload, body, body_codec) VALUES (?, ?, ?, ?, ?, ?)")
                    .run("toolcall", 1234, 2, "{}", Buffer.from([0, 255, 1]), "identity");
                database.prepare("INSERT INTO audit_metadata VALUES (?, ?)").run("retained", "metadata");
            } finally { database.close(); }
        }
        assert.equal(runPersistenceProcess(`
            import assert from 'node:assert/strict';
            import { DatabaseSync } from 'node:sqlite';
            const { home, boundary } = JSON.parse(process.argv[1]);
            const exec = DatabaseSync.prototype.exec;
            let hits = 0;
            DatabaseSync.prototype.exec = function(sql) {
                if (hits === 0 && (boundary === 'commit' ? sql === 'COMMIT' : sql.includes('PRAGMA user_version = 3'))) {
                    hits++;
                    throw new Error('injected migration failure before ' + boundary);
                }
                return exec.call(this, sql);
            };
            const { migrateAuditState } = await import(${JSON.stringify(moduleUrl)});
            assert.equal(await migrateAuditState(home), true);
            assert.equal(hits, 1);
            process.stdout.write('fault observed; neighbor migrated');
        `, { home, boundary }), "fault observed; neighbor migrated");
        const versions = files.map((file) => {
            const database = new DatabaseSync(file, { readOnly: true });
            try { return database.prepare("PRAGMA user_version").get()?.user_version; }
            finally { database.close(); }
        });
        assert.deepEqual(versions, [2, 3]);
        assert.deepEqual(await inspectAuditMigration(home), { files, deferredFiles: [], required: true });
        assert.equal(await migrateAuditState(home), true);
        for (const file of files) {
            const database = new DatabaseSync(file, { readOnly: true });
            try {
                assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 3);
                assert.equal(database.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
                assert.deepEqual({ ...database.prepare("SELECT * FROM audit_records").get() }, {
                    id: 1, collection: "toolcall", occurred_at_ms: 1234, payload_bytes: 2,
                    payload: "{}", body: new Uint8Array([0, 255, 1]), body_codec: "identity",
                });
                assert.equal(database.prepare("SELECT value FROM audit_metadata WHERE key = 'retained'").get()?.value, "metadata");
                assert.equal(database.prepare("SELECT count(*) AS count FROM state_records").get()?.count, 0);
            } finally { database.close(); }
        }
        assert.equal(await migrateAuditState(home), false);
        assert.deepEqual(await inspectAuditMigration(home), { files, deferredFiles: [], required: false });
    });
}
