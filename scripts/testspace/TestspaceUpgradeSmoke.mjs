import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
    buildTestspaceGlobalConfig, buildTestspaceInstanceConfig, TESTSPACE_INSTANCE,
} from "./TestspaceConfig.mjs";
import { assertTestspaceExecutionContext } from "./TestspaceNamespace.mjs";
import { createTestspaceProcessEnvironment } from "./TestspaceRuntime.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const target = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const appName = `portable-devshell-app-${target}.tar.gz`;
const workerName = `devshell-worker-${target}`;
const agentName = "portable-devshell-agent.dsext";
const baselineTag = "v0.7.7";
const baselineCache = join(repo, "var", "agent-work", "upgrade-testspace-assets", baselineTag);

/** Reproducible real release-upgrade acceptance; no mocked CLI or Control. */
export async function runTestspaceUpgradeSmoke({ root, baselineDirectory = baselineCache, candidateDirectory, caseName, diagnosticsOnly = false }) {
    assertTestspaceExecutionContext(root, process.env);
    assert.equal(process.env.HOME, join(root, "home"));
    assert.equal(process.env.PORTABLE_DEVSHELL_HOME, join(root, "home", ".devshell"));
    if (process.platform !== "linux") throw new Error("upgrade-smoke currently supports Linux only.");
    // Keep the installed releases outside the source tree: v0.7.7 scans
    // ancestor directories for a development Worker and would otherwise
    // pick a newer test build instead of its installed release Worker.
    const testRoot = await mkdtemp(join(tmpdir(), "pds-upgrade-testspace-"));
    try {
        const legacy = resolve(baselineDirectory);
        await acquireLegacyRelease(legacy);
        const current = candidateDirectory === undefined ? join(testRoot, "candidate") : resolve(candidateDirectory);
        if (candidateDirectory === undefined) await buildCandidateRelease(current);
        await verifyRelease(legacy);
        await verifyRelease(current);
        const standardCases = [
            "successful-upgrade",
            "existing-comment-target-recovery",
            "failed-startup-rollback",
            "partial-audit-migration-rollback",
            "unsupported-schema-rejection",
            "incident-expired-contexts",
            "incident-missing-instance",
            "incident-disconnected-control",
        ];
        if (caseName !== undefined && !standardCases.includes(caseName)) {
            throw new Error(`Unknown upgrade Testspace case: ${caseName}`);
        }
        const cases = [];
        for (const name of caseName === undefined ? standardCases : [caseName]) {
            const result = await runCase(name, { current, legacy, testRoot });
            if (name.startsWith("incident-") && !diagnosticsOnly)
                assert.ok(result.passed,
                    `Context upgrade regression: ${name}: ${JSON.stringify(result)}`);
            cases.push(result);
        }
        return {
            baseline: baselineTag,
            candidate: cases.find((entry) => entry.name === "successful-upgrade")?.version ?? "release-assets",
            cases,
        };
    } finally {
        await rm(testRoot, { recursive: true, force: true });
    }
}

async function acquireLegacyRelease(directory) {
    const files = [
        appName, `${appName}.sha256`, workerName, `${workerName}.sha256`,
        agentName, `${agentName}.sha256`, "install-release.sh",
    ];
    if (files.every(name => existsSync(join(directory, name)))) return;
    await mkdir(directory, { recursive: true });
    execute("gh", [
        "release", "download", baselineTag, "--repo", "Aromatic05/portable-devshell",
        "--dir", directory, "--clobber",
        ...files.flatMap(name => ["--pattern", name]),
    ], process.env, { timeout: 180_000 });
}

async function buildCandidateRelease(directory) {
    await mkdir(directory, { recursive: true });
    execute(process.execPath, [join(repo, "scripts/package-app.mjs"), "--output-dir", directory], process.env, { timeout: 180_000 });
    const worker = join(repo, "target", "debug", "devshell-worker");
    assert.ok(existsSync(worker), "testspace requires pnpm test:prepare worker");
    await copyFile(worker, join(directory, workerName));
    const hash = createHash("sha256").update(await readFile(worker)).digest("hex");
    await writeFile(join(directory, `${workerName}.sha256`), `${hash}\n`);
    execute(process.execPath, [
        join(repo, "scripts", "package-agent.mjs"), "--output-dir", directory,
    ], process.env, { timeout: 180_000 });
}

async function verifyRelease(directory) {
    for (const name of [appName, workerName, agentName]) {
        const expected = (await readFile(join(directory, `${name}.sha256`), "utf8")).trim().split(/\s+/u)[0];
        assert.match(expected, /^[0-9a-f]{64}$/iu);
        const actual = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
        assert.equal(actual, expected, `Corrupt release asset ${name}`);
    }
}

async function runCase(name, { current, legacy, testRoot }) {
    const root = join(testRoot, name);
    const home = join(root, "home");
    const runtime = await mkdtemp(join(tmpdir(), "pds-upgrade-"));
    const installation = join(root, "install");
    const bin = join(root, "bin");
    const devshellHome = join(home, ".devshell");
    const cli = join(bin, "devshell");
    const baselineInstaller = join(legacy, "install-release.sh");
    const candidateInstaller = existsSync(join(current, "install-release.sh"))
        ? join(current, "install-release.sh")
        : join(repo, "scripts", "install-release.sh");
    const env = {
        ...createTestspaceProcessEnvironment(home, runtime),
        PORTABLE_DEVSHELL_HOME: devshellHome,
        PORTABLE_DEVSHELL_INSTALL_ROOT: installation,
        PORTABLE_DEVSHELL_BIN_DIR: bin,
        // In Linux user namespaces, root is mapped only to the invoking UID.
        // Official tarballs legitimately carry foreign owner IDs.
        TAR_OPTIONS: "--no-same-owner",
    };
    const baselineEnv = {
        ...env,
        // v0.7.7 prefers a nearby development Worker over its installed
        // release asset. Pin the authentic release binary, not the repository
        // being upgraded, for the old Control's complete lifetime.
        [`PORTABLE_DEVSHELL_WORKER_${target.replaceAll("-", "_").toUpperCase()}_PATH`]:
            join(legacy, workerName),
    };
    const auditPath = join(devshellHome, TESTSPACE_INSTANCE, "control-worker", "audit.sqlite3");
    const legacyMessagePath = join(devshellHome, TESTSPACE_INSTANCE, "control-worker", "conversation.sqlite3");
    const newMessagePath = join(home, ".local", "share", "portable-devshell", "extension-data",
        "comment", "instances", encodeURIComponent(TESTSPACE_INSTANCE), "message.sqlite3");
    const legacyProvidersPath = join(devshellHome, "control", "extensions", "state", "agent", "providers.json");
    const newProvidersPath = join(home, ".local", "share", "portable-devshell",
        "extension-data", "agent", "providers.sqlite3");
    const contextsPath = join(devshellHome, "control", "contexts.json");
    let started = false;
    try {
        await mkdir(home, { recursive: true });
        const mcpPort = await freePort();
        const webPort = await freePort(new Set([mcpPort]));
        await mkdir(join(devshellHome, "control", "instances"), { recursive: true });
        const controlConfig = join(devshellHome, "control", "config.toml");
        const instanceConfig = join(devshellHome, "control", "instances", `${TESTSPACE_INSTANCE}.toml`);
        await writeFile(
            controlConfig,
            buildTestspaceGlobalConfig({ mcpPort, webPort }),
        );
        await writeFile(
            instanceConfig,
            buildTestspaceInstanceConfig(),
        );

        install(baselineInstaller, legacy, env);
        const baselineVersion = queryVersion(cli, env);
        assert.equal(baselineVersion, "0.7.7");
        execute(cli, ["start"], baselineEnv);
        started = true;
        assert.match(execute(cli, ["status"], env).stdout, /control: running/u);
        execute(cli, ["instance", "start", TESTSPACE_INSTANCE], baselineEnv);
        assert.ok(existsSync(auditPath), "Real 0.7.7 Worker did not open its Audit database");
        const before = seedAndReadAudit(auditPath);
        assert.equal(before.version, 2);
        const legacyMessage = await seedLegacyMessage(legacyMessagePath);
        const legacyProviders = await seedLegacyProviders(legacyProvidersPath);
        if (name === "existing-comment-target-recovery") {
            await seedExistingMessageTarget(newMessagePath);
        }
        execute(cli, ["extension", "install", join(legacy, agentName)], baselineEnv);
        assert.match(
            execute(cli, ["agent", "provider", "default"], baselineEnv).stdout,
            /"provider"\s*:\s*"pi"/u,
            "v0.7.7 Agent must read the original providers.json",
        );
        const legacyContexts = await seedLegacyContexts(
            contextsPath, TESTSPACE_INSTANCE, name.startsWith("incident-"),
            name === "incident-missing-instance",
        );
        const originalControlConfig = await readFile(controlConfig, "utf8");
        const originalInstanceConfig = await readFile(instanceConfig, "utf8");
        const baselineExtensions = execute(cli, ["extension", "list"], env).stdout;
        assert.match(baselineExtensions, /comment/u);
        assert.match(baselineExtensions, /mcp/u);
        const contextsImmediatelyBeforeInstall = name.startsWith("incident-")
            ? JSON.parse(await readFile(contextsPath, "utf8")).contexts
            : undefined;

        if (name === "unsupported-schema-rejection") {
            setAuditVersion(auditPath, 1);
            const failed = install(candidateInstaller, current, env, true);
            assert.notEqual(failed.status, 0, "unsupported audit schema must be rejected");
            assert.equal(queryVersion(cli, env), baselineVersion);
            assert.match(execute(cli, ["status"], env).stdout, /control: running/u);
            assert.equal(readAudit(auditPath).version, 1);
            assert.deepEqual(readMessage(legacyMessagePath, "conversation_entries"), legacyMessage);
            assert.equal(await readFile(legacyProvidersPath, "utf8"), legacyProviders);
            assert.equal(await readFile(contextsPath, "utf8"), legacyContexts);
            assert.ok(!existsSync(newMessagePath));
            assert.ok(!existsSync(newProvidersPath));
            assert.equal(await readFile(controlConfig, "utf8"), originalControlConfig);
            assert.equal(await readFile(instanceConfig, "utf8"), originalInstanceConfig);
            return { name, passed: true, version: baselineVersion, migration: "rejected" };
        }

        if (name === "partial-audit-migration-rollback") {
            const secondDatabase = join(devshellHome, "zz-failure", "control-worker", "audit.sqlite3");
            await seedConflictingAuditDatabase(secondDatabase);
            const failed = install(candidateInstaller, current, env, true);
            assert.notEqual(failed.status, 0, "second Audit database must fail after the first migration");
            assert.equal(queryVersion(cli, env), baselineVersion);
            assert.match(execute(cli, ["status"], env).stdout, /control: running/u);
            assert.equal(readAudit(auditPath).version, 2, "first Audit database must be rolled back");
            assert.equal(readAudit(auditPath).sentinel, before.sentinel);
            assert.equal(readAudit(secondDatabase).version, 2);
            assert.deepEqual(readMessage(legacyMessagePath, "conversation_entries"), legacyMessage);
            assert.equal(await readFile(legacyProvidersPath, "utf8"), legacyProviders);
            assert.equal(await readFile(contextsPath, "utf8"), legacyContexts);
            assert.ok(!existsSync(newMessagePath));
            assert.ok(!existsSync(newProvidersPath));
            return { name, passed: true, version: baselineVersion, migration: "two-database-rollback" };
        }

        const candidate = name === "failed-startup-rollback"
            ? await makeFailingCandidate(current, root)
            : name === "incident-disconnected-control"
                ? await makeDisconnectedCandidate(current, root)
                : current;
        const attempted = install(candidateInstaller, candidate, env, name !== "successful-upgrade");
        if (name.startsWith("incident-")) {
            const output = `${attempted.stdout ?? ""}\n${attempted.stderr ?? ""}`;
            const handshakeFailure = output.includes("server.hello must be the first request");
            const routeFailure = output.includes("No route for testspace-removed");
            const errorSignatures = [...new Set(output.split("\n")
                .map((line) => line.trim())
                .filter((line) => /No route for|server\.hello must|Context environment cleanup was incomplete|Control startup failed|File exists|持久状态回滚失败/u.test(line))
                .map((line) => line.slice(0, 220)))].slice(0, 12);
            const status = execute(cli, ["status"], env, { allowFailure: true });
            const restoredVersion = queryVersion(cli, env);
            const restoredContexts = await readFile(contextsPath, "utf8");
            const restoredAudit = readAudit(auditPath);
            const originalContextRecords = JSON.parse(legacyContexts).contexts;
            const restoredContextRecords = JSON.parse(restoredContexts).contexts;
            const restoredIds = new Set(restoredContextRecords.map((entry) => entry.ctxId));
            const removedRecords = originalContextRecords.filter((entry) => !restoredIds.has(entry.ctxId));
            const sentinel = originalContextRecords.find((entry) => entry.ctxId === "ctx-upgrade-legacy-sentinel");
            const restoredSentinel = restoredContextRecords.find((entry) => entry.ctxId === "ctx-upgrade-legacy-sentinel");
            const unresolvedInstanceDebt = restoredContextRecords.some((entry) =>
                entry.pendingEnvironmentCleanup?.some((cleanup) => cleanup.instance === "testspace-removed"),
            );
            const healthy = attempted.status === 0 &&
                restoredVersion.startsWith("1.0.0") &&
                (status.stdout ?? "").includes("control: running") &&
                restoredAudit.version === 3 &&
                restoredSentinel?.ctxId === sentinel?.ctxId &&
                (name !== "incident-missing-instance" || unresolvedInstanceDebt);
            return {
                name,
                passed: healthy,
                diagnosticCompleted: true,
                candidateFailed: attempted.status !== 0,
                reproduced: attempted.status !== 0 &&
                    (name === "incident-disconnected-control"
                        ? handshakeFailure
                        : name === "incident-missing-instance"
                            ? handshakeFailure
                            : true),
                installerExitCode: attempted.status,
                failure: {
                    contextCleanup: output.includes("Context environment cleanup was incomplete"),
                    handshake: handshakeFailure,
                    missingInstanceRoute: routeFailure,
                    rollback: /File exists|持久状态回滚失败/u.test(output),
                },
                errorSignatures,
                postInstallVersion: restoredVersion,
                unresolvedInstanceDebt,
                rollbackStatePreserved: attempted.status !== 0 ? {
                    version: restoredVersion === baselineVersion,
                    contextsRaw: restoredContexts === legacyContexts,
                    contextsSentinel: JSON.stringify(sentinel) === JSON.stringify(restoredSentinel),
                    contextsOriginalCount: originalContextRecords.length,
                    contextsBeforeInstallerCount: contextsImmediatelyBeforeInstall?.length,
                    contextsRestoredCount: restoredContextRecords.length,
                    compactedTerminalContexts: removedRecords.filter((entry) => entry.status !== "active").length,
                    compactedPendingContexts: removedRecords.filter((entry) => entry.cleanupPending === true).length,
                    removedActiveContexts: removedRecords.filter((entry) => entry.status === "active").length,
                    audit: restoredAudit.version === before.version &&
                        restoredAudit.sentinel === before.sentinel,
                } : undefined,
                status: (status.stdout ?? "").split("\n").filter((line) =>
                    line.startsWith("control:") || line.startsWith("devshell ")
                ),
                diagnostics: output.slice(-6000),
            };
        }
        if (name === "failed-startup-rollback") {
            assert.notEqual(attempted.status, 0, "fault-injected candidate must fail");
            assert.equal(queryVersion(cli, env), baselineVersion);
            assert.match(execute(cli, ["status"], env).stdout, /control: running/u);
            const after = readAudit(auditPath);
            assert.equal(after.version, before.version);
            assert.equal(after.sentinel, before.sentinel);
            assert.equal(after.rows, before.rows);
            assert.deepEqual(readMessage(legacyMessagePath, "conversation_entries"), legacyMessage);
            assert.equal(await readFile(legacyProvidersPath, "utf8"), legacyProviders);
            assert.equal(await readFile(contextsPath, "utf8"), legacyContexts);
            assert.ok(!existsSync(newMessagePath));
            assert.ok(!existsSync(newProvidersPath));
            assert.equal(await readFile(controlConfig, "utf8"), originalControlConfig);
            assert.equal(await readFile(instanceConfig, "utf8"), originalInstanceConfig);
            return { name, passed: true, version: baselineVersion, migration: "rolled-back" };
        }
        assert.equal(attempted.status, 0);
        const candidateVersion = queryVersion(cli, env);
        assert.match(candidateVersion, /^1\.0\.0/u);
        assert.match(execute(cli, ["status"], env).stdout, /control: running/u);
        const after = readAudit(auditPath);
        assert.equal(after.version, 3);
        assert.equal(after.sentinel, before.sentinel);
        assert.ok(after.rows >= before.rows);
        assert.equal(await readFile(controlConfig, "utf8"), originalControlConfig);
        assert.equal(await readFile(instanceConfig, "utf8"), originalInstanceConfig);
        // Agent is an explicitly installed Extension, not a Core builtin.
        const upgradedContexts = JSON.parse(await readFile(contextsPath, "utf8"));
        const oldContext = JSON.parse(legacyContexts).contexts[0];
        const upgradedContext = upgradedContexts.contexts.find((record) =>
            record.ctxId === oldContext.ctxId
        );
        assert.equal(upgradedContexts.version, 2);
        assert.ok(upgradedContext, "Legacy Context was lost during upgrade");
        assert.deepEqual(upgradedContext.environments, oldContext.environments);
        assert.equal(upgradedContext.principal, oldContext.principal);
        assert.ok(!("instance" in upgradedContext) && !("workspace" in upgradedContext));
        // Agent is an explicitly installed Extension, not a Core builtin.
        // Replace the API 4 generation with the current API 5 artifact.
        execute(cli, ["extension", "install", join(current, agentName)], env);
        execute(cli, ["agent", "provider", "list"], env);
        assert.deepEqual(readProviderDatabase(newProvidersPath), JSON.parse(legacyProviders));
        assert.match(
            execute(cli, ["agent", "provider", "default"], env).stdout,
            /"provider"\s*:\s*"pi"/u,
        );
        await activateCommentHistory(runtime, TESTSPACE_INSTANCE);
        const migratedMessage = readMessage(newMessagePath, "message_entries");
        assert.deepEqual(migratedMessage.records, legacyMessage.records);
        assert.equal(migratedMessage.total, legacyMessage.total +
            (name === "existing-comment-target-recovery" ? 1 : 0));
        if (name === "existing-comment-target-recovery") {
            assert.equal(
                readMessageRecord(newMessagePath, "message_entries", "newer-comment").text,
                "Existing newer Comment preserved",
            );
        }
        assert.equal(readSchemaVersion(newMessagePath), 2);
        assert.deepEqual(readMessage(legacyMessagePath, "conversation_entries"), legacyMessage);
        const extensions = execute(cli, ["extension", "list"], env).stdout;
        for (const id of ["access", "comment", "instance", "mcp"]) {
            assert.match(extensions, new RegExp(`^${id}\\s`, "mu"));
            assert.doesNotMatch(extensions, new RegExp(`^${id}[^\\n]*failed`, "mu"));
        }
        const overview = execute(cli, ["overview"], env).stdout;
        assert.match(overview, new RegExp(TESTSPACE_INSTANCE, "u"));
        const instance = execute(cli, ["instance", "list"], env).stdout;
        assert.match(instance, new RegExp(TESTSPACE_INSTANCE, "u"));
        return { name, passed: true, version: candidateVersion, migration: "audit-2-to-3,context-1-to-2,comment-1-to-2,agent-json-to-sqlite" };
    } finally {
        if (started && existsSync(cli)) execute(cli, ["stop"], env, { allowFailure: true });
        await stopLeftoverTestWorker(
            join(devshellHome, TESTSPACE_INSTANCE, "state", "worker.pid"),
            root,
        );
        await rm(runtime, { recursive: true, force: true });
    }
}

async function stopLeftoverTestWorker(pidPath, caseRoot) {
    let pid;
    try {
        pid = Number((await readFile(pidPath, "utf8")).trim());
    } catch {
        return;
    }
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    const command = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf8",
        timeout: 3_000,
    });
    if (command.status !== 0 || !command.stdout.includes(caseRoot + "/")) return;
    process.kill(pid, "SIGTERM");
}

function seedAndReadAudit(file) {
    const database = new DatabaseSync(file);
    try {
        const version = Number(database.prepare("PRAGMA user_version").get().user_version);
        assert.equal(version, 2);
        const payload = JSON.stringify({
            at: new Date().toISOString(),
            message: "testspace-upgrade-sentinel",
            seq: 927006,
        });
        database.prepare(
            "INSERT INTO audit_records(collection, occurred_at_ms, payload_bytes, payload, body, body_codec) VALUES (?, ?, ?, ?, NULL, NULL)",
        ).run("logs", Date.now(), Buffer.byteLength(payload), payload);
    } finally {
        database.close();
    }
    return readAudit(file);
}

function readAudit(file) {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
        assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        return {
            version: Number(database.prepare("PRAGMA user_version").get().user_version),
            rows: Number(database.prepare("SELECT COUNT(*) AS count FROM audit_records").get().count),
            sentinel: database.prepare(
                "SELECT payload FROM audit_records WHERE json_extract(payload, '$.seq') = 927006",
            ).get()?.payload,
        };
    } finally {
        database.close();
    }
}

async function seedLegacyMessage(file) {
    await mkdir(dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    try {
        database.exec(`
            CREATE TABLE IF NOT EXISTS conversation_entries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('comment', 'report')),
                id TEXT NOT NULL,
                ctx_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                text TEXT NOT NULL,
                status TEXT CHECK(status IS NULL OR status IN ('pending', 'sent', 'delivered', 'failed')),
                call_id TEXT,
                delivered_at TEXT,
                failed_at TEXT,
                error TEXT,
                UNIQUE(kind, id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS conversation_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 1;
        `);
        database.prepare(
            "INSERT OR REPLACE INTO conversation_entries (kind, id, ctx_id, created_at, text, status, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
            "comment", "upgrade-comment-1729", "ctx-upgrade-1729",
            "2026-09-25T09:00:00.000Z", "Legacy v0.7.7 Comment preserved",
            "delivered", "2026-09-25T09:00:01.000Z",
        );
    } finally {
        database.close();
    }
    assert.equal(readSchemaVersion(file), 1);
    return readMessage(file, "conversation_entries");
}

function readSchemaVersion(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return Number(db.prepare("PRAGMA user_version").get().user_version);
    } finally {
        db.close();
    }
}

function readMessage(file, table) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        return {
            records: db.prepare(
                `SELECT kind, id, ctx_id, created_at, text, status, delivered_at FROM ${table} WHERE id = ? ORDER BY seq`,
            ).all("upgrade-comment-1729"),
            total: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
        };
    } finally {
        db.close();
    }
}

function readMessageRecord(file, table, id) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return db.prepare(`SELECT id, text FROM ${table} WHERE id = ?`).get(id);
    } finally {
        db.close();
    }
}

async function seedExistingMessageTarget(file) {
    await mkdir(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
        db.exec(`
            CREATE TABLE message_entries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('comment', 'report')),
                id TEXT NOT NULL,
                ctx_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                text TEXT NOT NULL,
                status TEXT CHECK(status IS NULL OR status IN ('pending', 'sent', 'delivered', 'failed')),
                call_id TEXT,
                delivered_at TEXT,
                failed_at TEXT,
                error TEXT,
                UNIQUE(kind, id)
            ) STRICT;
            CREATE TABLE message_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 2;
        `);
        db.prepare(
            "INSERT INTO message_entries (kind,id,ctx_id,created_at,text,status) VALUES ('comment',?, 'ctx-upgrade-1729',?,?,'delivered')",
        ).run("newer-comment", "2026-10-10T09:00:00.000Z", "Existing newer Comment preserved");
    } finally {
        db.close();
    }
}

async function seedLegacyProviders(file) {
    await mkdir(dirname(file), { recursive: true });
    const content = JSON.stringify({
        defaultProvider: "pi",
        providers: { pi: { enabled: false, installedVersion: "1.2.3" } },
        schemaVersion: 2,
    }, null, 2) + "\n";
    await writeFile(file, content, { mode: 0o600 });
    return content;
}

async function seedLegacyContexts(file, instance, incident = false, missingInstance = false) {
    await mkdir(dirname(file), { recursive: true });
    const existing = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {
        contexts: [],
        version: 1,
    };
    assert.equal(existing.version, 1, "v0.7.7 Context registry must be version 1");
    const at = new Date().toISOString();
    const record = {
        createdAt: at,
        ctxId: "ctx-upgrade-legacy-sentinel",
        environments: [{ instance, workspace: "/" }],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        instance,
        lastAccessedAt: at,
        principal: "upgrade-testspace",
        status: "active",
        workspace: "/",
    };
    const historicalContexts = incident ? Array.from({ length: 503 }, (_, index) => {
        const disabled = index >= 465 && index < 483;
        const needsCleanup = index < 209 || disabled;
        const deletedInstance = missingInstance && index === 0;
        const cleanupInstance = deletedInstance ? "testspace-removed" : instance;
        return {
            ...record,
            // Match the observed 227 cleanup debts and 256 retained terminal records.
            // Older disabled records must be included in the first 227 compaction entries.
            createdAt: disabled ? "2026-08-31T00:00:00.000Z" : "2026-09-01T00:00:00.000Z",
            ctxId: `ctx-testspace-incident-${String(index).padStart(4, "0")}`,
            ...(deletedInstance ? {
                environments: [{ instance: cleanupInstance, workspace: "/" }],
                instance: cleanupInstance,
            } : {}),
            expiresAt: index < 483 ? "2026-09-02T00:00:00.000Z" : record.expiresAt,
            lastAccessedAt: "2026-09-01T00:00:00.000Z",
            status: index < 465 ? "expired" : index < 483 ? "disabled" : "active",
            ...(needsCleanup ? {
                cleanupPending: true,
                pendingEnvironmentCleanup: deletedInstance
                    ? [{ kind: "instance_reference", instance: cleanupInstance }]
                    : [{ kind: "alerts", instance, workspace: "/" }],
            } : {}),
        };
    }) : [];
    const source = JSON.stringify({
        contexts: [
            ...existing.contexts.filter((item) => item.ctxId !== record.ctxId),
            ...historicalContexts,
            record,
        ],
        version: 1,
    }, null, 2) + "\n";
    await writeFile(file, source, { mode: 0o600 });
    return source;
}

function readProviderDatabase(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        const row = db.prepare("SELECT snapshot FROM provider_registry WHERE id = 1").get();
        assert.ok(row, "Agent Host Database did not import the old registry");
        return JSON.parse(row.snapshot);
    } finally {
        db.close();
    }
}

async function activateCommentHistory(runtimeDirectory, instance) {
    const { createTuiDomainSession, TuiControlSession } =
        await import("../../packages/tui/dist/testing.js");
    const domains = createTuiDomainSession({ xdgRuntimeDir: runtimeDirectory });
    const session = new TuiControlSession({ domains });
    try {
        await session.start();
        await domains.messages.load([instance]);
    } finally {
        await session.stop();
    }
}

async function seedConflictingAuditDatabase(file) {
    await mkdir(dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    try {
        database.exec(`
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
            CREATE TABLE state_records (collision TEXT NOT NULL) STRICT;
            PRAGMA user_version = 2;
        `);
    } finally {
        database.close();
    }
}

function setAuditVersion(file, version) {
    const database = new DatabaseSync(file);
    try { database.exec(`PRAGMA user_version = ${version}`); }
    finally { database.close(); }
}

async function makeFailingCandidate(current, root) {
    const bad = join(root, "fault-candidate");
    const app = join(root, "fault-app");
    await mkdir(bad, { recursive: true });
    await mkdir(app, { recursive: true });
    execute("tar", ["--no-same-owner", "-xzf", join(current, appName), "-C", app], process.env);
    const daemon = join(app, "node_modules/@portable-devshell/control/dist/server/Daemon.js");
    const original = await readFile(daemon, "utf8");
    await writeFile(daemon, 'throw new Error("testspace intentional candidate daemon failure");\n' + original);
    execute("tar", ["-czf", join(bad, appName), "-C", app, "."], process.env);
    const hash = createHash("sha256").update(await readFile(join(bad, appName))).digest("hex");
    await writeFile(join(bad, `${appName}.sha256`), `${hash}  ${appName}\n`);
    for (const name of [workerName, `${workerName}.sha256`]) {
        await copyFile(join(current, name), join(bad, name));
    }
    return bad;
}

async function makeDisconnectedCandidate(current, root) {
    const candidate = join(root, "disconnected-candidate");
    const app = join(root, "disconnected-app");
    await mkdir(candidate, { recursive: true });
    await mkdir(app, { recursive: true });
    execute("tar", ["--no-same-owner", "-xzf", join(current, appName), "-C", app], process.env);
    const server = join(app, "node_modules/@portable-devshell/control/dist/server/index.js");
    const original = await readFile(server, "utf8");
    const marker = "        await this.#web.startHost();";
    assert.equal(original.split(marker).length, 2, "Expected one Control startHosts marker");
    await writeFile(server, original.replace(marker,
        `${marker}\n        this.#internalControlEndpoint.disconnect();`));
    execute("tar", ["-czf", join(candidate, appName), "-C", app, "."], process.env);
    const hash = createHash("sha256").update(await readFile(join(candidate, appName))).digest("hex");
    await writeFile(join(candidate, `${appName}.sha256`), `${hash}  ${appName}\n`);
    for (const name of [workerName, `${workerName}.sha256`]) {
        await copyFile(join(current, name), join(candidate, name));
    }
    return candidate;
}

function install(installer, directory, env, allowFailure = false) {
    return execute("sh", [installer], {
        ...env, PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(directory).href,
    }, { allowFailure, timeout: 180_000 });
}

function queryVersion(cli, env) {
    const text = execute(cli, ["--version"], env).stdout;
    const match = /devshell\s+([^\s]+)/u.exec(text);
    assert.ok(match, `Invalid CLI version output: ${text}`);
    return match[1];
}

function execute(command, args, env, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repo,
        encoding: "utf8",
        // Inside Testspace's user namespace, uid 0 maps to a single host uid.
        // The release tar may contain unmapped owners; only file content and
        // permissions belong to the isolated installation, not archive owners.
        env: { ...env, TAR_OPTIONS: "--no-same-owner" },
        timeout: options.timeout ?? 65_000,
        maxBuffer: 8 * 1024 * 1024,
    });
    if (!options.allowFailure && (result.error || result.status !== 0)) {
        throw new Error(
            `${command} ${args.join(" ")} failed (${result.status}):\n` +
            `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
        );
    }
    return result;
}

async function freePort(exclude = new Set()) {
    return await new Promise((resolvePort, rejectPort) => {
        const server = createServer();
        server.once("error", rejectPort);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            server.close(() => {
                if (exclude.has(port)) resolvePort(freePort(exclude));
                else resolvePort(port);
            });
        });
    });
}
