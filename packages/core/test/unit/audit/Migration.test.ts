import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
    inspectAuditDatabase,
    migrateAuditDatabase,
} from "../../../src/audit/database/Migration.js";

test("Audit database schema 2 upgrades atomically to 3 without losing records", () => {
    const root = mkdtempSync(join(tmpdir(), "devshell-audit-upgrade-"));
    const file = join(root, "audit.sqlite3");
    const sentinel = JSON.stringify({ seq: 1729, message: "kept across upgrade" });
    try {
        const old = new DatabaseSync(file);
        old.exec(`
            CREATE TABLE audit_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                payload TEXT NOT NULL,
                body BLOB,
                body_codec TEXT
            ) STRICT;
            CREATE TABLE audit_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 2;
        `);
        old.prepare(
            "INSERT INTO audit_records(collection, occurred_at_ms, payload_bytes, payload) VALUES (?, ?, ?, ?)",
        ).run("logs", Date.now(), Buffer.byteLength(sentinel), sentinel);
        old.close();

        assert.deepEqual(inspectAuditDatabase(file), { changed: true, version: 2 });
        assert.equal(migrateAuditDatabase(file), true);
        assert.deepEqual(inspectAuditDatabase(file), { changed: false, version: 3 });
        assert.equal(migrateAuditDatabase(file), false);

        const db = new DatabaseSync(file);
        assert.equal(db.prepare("SELECT payload FROM audit_records").get()?.payload, sentinel);
        assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
        db.prepare(
            "INSERT INTO state_records(namespace, key, payload, payload_bytes) VALUES (?, ?, ?, ?)",
        ).run("test", "saved", '{"present":true}', 16);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM state_records").get()?.n, 1);
        db.close();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Audit database versions outside the migratable range remain untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "devshell-audit-upgrade-"));
    try {
        for (const version of [1, 4]) {
            const file = join(root, `audit-${version}.sqlite3`);
            const db = new DatabaseSync(file);
            db.exec(`PRAGMA user_version = ${version}`);
            db.close();
            assert.throws(() => inspectAuditDatabase(file), /unsupported|newer/u);
            assert.throws(() => migrateAuditDatabase(file), /unsupported|newer/u);
            const verified = new DatabaseSync(file, { readOnly: true });
            assert.equal(verified.prepare("PRAGMA user_version").get()?.user_version, version);
            verified.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
