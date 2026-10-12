import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const baselineTag = "v0.7.7";
const baselineCache = join(repo, "var", "agent-work", "upgrade-testspace-assets", baselineTag);

/** Reproducible real release-upgrade acceptance; no mocked CLI or Control. */
export async function runTestspaceUpgradeSmoke({ root, baselineDirectory = baselineCache, candidateDirectory }) {
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
        const successful = await runCase("successful-upgrade", { current, legacy, testRoot });
        const rollback = await runCase("failed-startup-rollback", { current, legacy, testRoot });
        const unsupported = await runCase("unsupported-schema-rejection", { current, legacy, testRoot });
        return {
            baseline: baselineTag,
            candidate: successful.version,
            cases: [successful, rollback, unsupported],
        };
    } finally {
        await rm(testRoot, { recursive: true, force: true });
    }
}

async function acquireLegacyRelease(directory) {
    const files = [appName, `${appName}.sha256`, workerName, `${workerName}.sha256`, "install-release.sh"];
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
}

async function verifyRelease(directory) {
    for (const name of [appName, workerName]) {
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
    const candidateInstaller = join(repo, "scripts", "install-release.sh");
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
        const originalControlConfig = await readFile(controlConfig, "utf8");
        const originalInstanceConfig = await readFile(instanceConfig, "utf8");
        const baselineExtensions = execute(cli, ["extension", "list"], env).stdout;
        assert.match(baselineExtensions, /comment/u);
        assert.match(baselineExtensions, /mcp/u);

        if (name === "unsupported-schema-rejection") {
            setAuditVersion(auditPath, 1);
            const failed = install(candidateInstaller, current, env, true);
            assert.notEqual(failed.status, 0, "unsupported audit schema must be rejected");
            assert.equal(queryVersion(cli, env), baselineVersion);
            assert.match(execute(cli, ["status"], env).stdout, /control: running/u);
            assert.equal(readAudit(auditPath).version, 1);
            assert.equal(await readFile(controlConfig, "utf8"), originalControlConfig);
            assert.equal(await readFile(instanceConfig, "utf8"), originalInstanceConfig);
            return { name, passed: true, version: baselineVersion, migration: "rejected" };
        }

        const candidate = name === "failed-startup-rollback"
            ? await makeFailingCandidate(current, root)
            : current;
        const attempted = install(candidateInstaller, candidate, env, name !== "successful-upgrade");
        if (name === "failed-startup-rollback") {
            assert.notEqual(attempted.status, 0, "fault-injected candidate must fail");
            assert.equal(queryVersion(cli, env), baselineVersion);
            assert.match(execute(cli, ["status"], env).stdout, /control: running/u);
            const after = readAudit(auditPath);
            assert.equal(after.version, before.version);
            assert.equal(after.sentinel, before.sentinel);
            assert.equal(after.rows, before.rows);
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
        const extensions = execute(cli, ["extension", "list"], env).stdout;
        for (const id of ["access", "comment", "instance", "mcp"]) {
            assert.match(extensions, new RegExp(`^${id}\\s`, "mu"));
            assert.doesNotMatch(extensions, new RegExp(`^${id}[^\\n]*failed`, "mu"));
        }
        const overview = execute(cli, ["overview"], env).stdout;
        assert.match(overview, new RegExp(TESTSPACE_INSTANCE, "u"));
        const instance = execute(cli, ["instance", "list"], env).stdout;
        assert.match(instance, new RegExp(TESTSPACE_INSTANCE, "u"));
        return { name, passed: true, version: candidateVersion, migration: "audit-2-to-3" };
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
