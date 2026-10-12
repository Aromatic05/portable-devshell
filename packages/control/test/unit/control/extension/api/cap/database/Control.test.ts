import assert from "node:assert/strict";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ExtensionDatabaseCapabilityControl } from "../../../../../../../src/extension/api/cap/database/index.ts";
import { createTestTempDirectory } from "../../../../../../../../../test/TestTempDirectory.ts";

test("Host Database owns SQL connections and commits multi-operation transactions", async (t) => {
    const root = await createTestTempDirectory("extension-database");
    const dataDirectory = join(root, "data");
    await mkdir(dataDirectory);
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const capability = new ExtensionDatabaseCapabilityControl({
        allowed: true,
        dataDirectory,
        extensionId: "comment",
    });
    const connection = await capability.open("instances/example/message");
    await connection.exec(
        "CREATE TABLE records(id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
    );
    await connection.exec("CREATE TABLE measurements(value REAL)");
    await connection.run(
        "INSERT INTO measurements(value) VALUES (?)",
        [3.14159],
    );
    assert.deepEqual(await connection.get("SELECT value FROM measurements"), {
        value: 3.14159,
    });
    await assert.rejects(
        connection.exec(
            "ATTACH DATABASE '/tmp/foreign-database.sqlite3' AS foreign_db",
        ),
        /authorized|not authorized|denied/u,
    );
    await assert.rejects(
        connection.exec("BEGIN IMMEDIATE"),
        /authorized|not authorized|denied/u,
    );
    const forbiddenExport = join(root, "unscoped.sqlite3");
    await assert.rejects(
        connection.exec(`VACUUM INTO '${forbiddenExport}'`),
        /authorized|not authorized|denied/u,
    );
    await connection.transaction(async (database) => {
        await database.run("INSERT INTO records(text) VALUES (?)", ["first"]);
        await database.run("INSERT INTO records(text) VALUES (?)", ["second"]);
    });
    assert.deepEqual(
        await connection.all("SELECT id, text FROM records ORDER BY id"),
        [
            { id: 1, text: "first" },
            { id: 2, text: "second" },
        ],
    );
    await assert.rejects(
        connection.transaction(async (database) => {
            await database.run("INSERT INTO records(text) VALUES (?)", [
                "rolled back",
            ]);
            throw new Error("abort");
        }),
        /abort/u,
    );
    assert.deepEqual(
        await connection.get("SELECT COUNT(*) AS count FROM records"),
        { count: 2 },
    );
    await connection.close();
    await assert.rejects(connection.all("SELECT 1"), /closed/u);

    const reopened = await capability.open("instances/example/message");
    assert.deepEqual(
        await reopened.get("SELECT COUNT(*) AS count FROM records"),
        { count: 2 },
    );
    capability.closeAll();
    await assert.rejects(reopened.all("SELECT 1"), /closed/u);
});

test("Host Database closes a transaction on deferred constraint failure during COMMIT", async (t) => {
    const root = await createTestTempDirectory(
        "extension-database-deferred-commit",
    );
    const dataDirectory = join(root, "data");
    await mkdir(dataDirectory);
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const capability = new ExtensionDatabaseCapabilityControl({
        allowed: true,
        dataDirectory,
        extensionId: "comment",
    });
    const connection = await capability.open("constraints");
    await connection.exec("PRAGMA foreign_keys = ON");
    await connection.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    await connection.exec(
        "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
    );
    await assert.rejects(
        connection.transaction(async (transaction) => {
            await transaction.run(
                "INSERT INTO child(id, parent_id) VALUES (?, ?)",
                [1, 999],
            );
        }),
        /FOREIGN KEY constraint failed/u,
    );
    await assert.rejects(
        connection.all("SELECT * FROM child"),
        /Unknown|retired/u,
    );
    const reopened = await capability.open("constraints");
    assert.deepEqual(
        await reopened.get("SELECT COUNT(*) AS count FROM child"),
        { count: 0 },
    );
    await reopened.close();
    capability.closeAll();
});

test("Host Database rejects traversal, foreign handles, symlinked directories and ungranted access", async (t) => {
    const root = await createTestTempDirectory("extension-database-scope");
    const dataDirectory = join(root, "data");
    await mkdir(dataDirectory);
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const runtime = new ExtensionDatabaseCapabilityControl({
        allowed: true,
        dataDirectory,
        extensionId: "comment",
    });
    for (const name of [
        "",
        "../escape",
        "/tmp/escape",
        "nested/../../escape",
        "x\\escape",
    ]) {
        await assert.rejects(
            runtime.open(name),
            /name must contain safe relative segments/u,
        );
    }
    await symlink(root, join(dataDirectory, "escape"));
    await assert.rejects(runtime.open("escape/message"), /plain directory/u);
    const id = await runtime.openHandle("safe");
    assert.throws(
        () => runtime.execute("forged", { mode: "exec", sql: "SELECT 1" }),
        /Unknown/u,
    );
    const token = runtime.begin(id);
    assert.throws(
        () => runtime.execute(id, { mode: "exec", sql: "SELECT 1" }),
        /lease/u,
    );
    assert.throws(() => runtime.end(id, "forged", true), /lease/u);
    runtime.closeAll();
    await assert.rejects(runtime.open("other"), /closed/u);
    const denied = new ExtensionDatabaseCapabilityControl({
        allowed: false,
        dataDirectory,
        extensionId: "foreign",
    });
    await assert.rejects(denied.open("safe"), /no database capability/u);
});
