import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const allTargets = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64"
];

test("Unix release installer activates the manifest-declared CLI and supports replacement", {
    skip: process.platform === "win32"
}, async () => {
    const root = await createTestTempDirectory("release-install-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const applicationVersion = "9.8.7-test";

    try {
        await mkdir(resolve(app, "custom"), { recursive: true });
        await mkdir(release, { recursive: true });
        await mkdir(home, { recursive: true });
        await writeFile(resolve(app, "package.json"), `${JSON.stringify({
            name: "portable-devshell",
            version: applicationVersion,
            private: true,
            type: "module",
            bin: { devshell: "./custom/devshell-entry.js" },
            engines: { node: ">=24" }
        }, null, 2)}\n`, "utf8");
        await writeFile(resolve(app, "portable-devshell-install.json"), `${JSON.stringify({
            minimumNodeMajor: 24,
            version: applicationVersion
        }, null, 2)}\n`, "utf8");
        const cli = resolve(app, "custom", "devshell-entry.js");
        await writeFile(cli, [
            "#!/usr/bin/env node",
            "const command = process.argv[2] ?? 'status';",
            "if (command === 'status') process.stdout.write('control: stopped\\n');",
            "else if (command === 'stop') process.exit(0);",
            "else { process.stderr.write(`unsupported test command: ${command}\\n`); process.exit(2); }",
            ""
        ].join("\n"), "utf8");
        await chmod(cli, 0o755);

        const archive = resolve(release, applicationAssetName());
        run("tar", ["-czf", archive, "-C", app, "."]);
        await writeChecksum(archive);

        for (const target of preinstalledTargets()) {
            const filename = target.startsWith("windows-")
                ? `devshell-worker-${target}.exe`
                : `devshell-worker-${target}`;
            const worker = resolve(release, filename);
            await writeFile(worker, `fake worker ${target}\n`, "utf8");
            await writeChecksum(worker);
        }

        const environment = {
            ...process.env,
            HOME: home,
            XDG_DATA_HOME: resolve(root, "data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome
        };

        runInstaller(environment);
        await assertInstalledLayout({ applicationVersion, binDirectory, devshellHome, installRoot });

        runInstaller(environment);
        await assertInstalledLayout({ applicationVersion, binDirectory, devshellHome, installRoot });
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Unix release installer restores the Control and managed instances that were running before replacement", {
    skip: process.platform === "win32"
}, async () => {
    const root = await createTestTempDirectory("release-runtime-restore-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const calls = resolve(root, "calls.log");
    const applicationVersion = "9.8.7-runtime-restore";
    const oldVersionDirectory = resolve(installRoot, "versions", "9.8.6-old");
    let oldControl;

    try {
        await mkdir(resolve(app, "custom"), { recursive: true });
        await mkdir(resolve(oldVersionDirectory, "custom"), { recursive: true });
        await mkdir(release, { recursive: true });
        await mkdir(home, { recursive: true });

        const packageManifest = (packageVersion) => `${JSON.stringify({
            name: "portable-devshell",
            version: packageVersion,
            private: true,
            type: "module",
            bin: { devshell: "./custom/devshell-entry.js" },
            engines: { node: ">=24" }
        }, null, 2)}\n`;
        await writeFile(resolve(oldVersionDirectory, "package.json"), packageManifest("9.8.6-old"), "utf8");
        const oldCli = resolve(oldVersionDirectory, "custom", "devshell-entry.js");
        await writeFile(oldCli, [
            "#!/usr/bin/env node",
            "import { appendFileSync, readFileSync, rmSync } from 'node:fs';",
            `const calls = ${JSON.stringify(calls)};`,
            `const pidFile = ${JSON.stringify(resolve(devshellHome, "control", "control.pid"))};`,
            "const command = process.argv[2] ?? 'status';",
            "const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);",
            "if (command === 'status') process.stdout.write(`control: running\\npid: ${pid}\\n`);",
            "else if (command === 'overview') process.stdout.write(JSON.stringify({ instances: [",
            "  { name: 'ready-local', snapshot: { daemonState: 'running' } },",
            "  { name: 'starting-ssh', snapshot: { daemonState: 'starting' } },",
            "  { name: 'stale-local', snapshot: { daemonState: 'stale' } },",
            "  { name: 'stopped-local', snapshot: { daemonState: 'stopped' } },",
            "  { name: 'reverse-node', snapshot: { daemonState: 'running', reverse: { connected: true } } }",
            "] }));",
            "else if (command === 'stop') { process.kill(pid, 'SIGTERM'); rmSync(pidFile, { force: true }); appendFileSync(calls, 'old:stop\\n'); }",
            "else process.exit(2);",
            ""
        ].join("\n"), "utf8");
        await chmod(oldCli, 0o755);
        await symlink("versions/9.8.6-old", resolve(installRoot, "current"));
        oldControl = await startFakeControl(oldVersionDirectory, devshellHome);

        await writeFile(resolve(app, "package.json"), packageManifest(applicationVersion), "utf8");
        await writeFile(resolve(app, "portable-devshell-install.json"), `${JSON.stringify({
            minimumNodeMajor: 24,
            version: applicationVersion
        }, null, 2)}\n`, "utf8");
        const cli = resolve(app, "custom", "devshell-entry.js");
        await writeFile(cli, [
            "#!/usr/bin/env node",
            "import { appendFileSync } from 'node:fs';",
            `const calls = ${JSON.stringify(calls)};`,
            `const liveHome = ${JSON.stringify(devshellHome)};`,
            "const command = process.argv[2] ?? 'status';",
            "if (command === 'status') process.stdout.write(process.env.PORTABLE_DEVSHELL_HOME === liveHome ? 'control: running\\n' : 'control: stopped\\n');",
            "else if (command === 'start') appendFileSync(calls, 'new:start\\n');",
            "else if (command === 'instance' && process.argv[3] === 'start') appendFileSync(calls, `new:instance:${process.argv[4]}\\n`);",
            "else process.exit(2);",
            ""
        ].join("\n"), "utf8");
        await chmod(cli, 0o755);

        const archive = resolve(release, applicationAssetName());
        run("tar", ["-czf", archive, "-C", app, "."]);
        await writeChecksum(archive);
        for (const target of preinstalledTargets()) {
            const worker = resolve(release, target.startsWith("windows-")
                ? `devshell-worker-${target}.exe`
                : `devshell-worker-${target}`);
            await writeFile(worker, `fake worker ${target}\n`, "utf8");
            await writeChecksum(worker);
        }

        const result = runInstaller({
            ...process.env,
            HOME: home,
            XDG_DATA_HOME: resolve(root, "data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome
        });

        assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [
            "old:stop",
            "new:start",
            "new:instance:ready-local",
            "new:instance:starting-ssh",
            "new:instance:stale-local",
        ]);
        assert.match(result.stdout, /恢复.*3.*实例/u);
    } finally {
        oldControl?.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
});

test("Unix release installer rejects an application that cannot start before activation", {
    skip: process.platform === "win32"
}, async () => {
    const root = await createTestTempDirectory("release-broken-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");

    try {
        await mkdir(resolve(app, "dist"), { recursive: true });
        await mkdir(release, { recursive: true });
        await mkdir(home, { recursive: true });
        await writeFile(resolve(app, "package.json"), `${JSON.stringify({
            name: "portable-devshell",
            version: "9.8.8-broken",
            private: true,
            type: "module",
            bin: { devshell: "./dist/CliMain.js" },
            engines: { node: ">=24" }
        }, null, 2)}\n`, "utf8");
        await writeFile(resolve(app, "portable-devshell-install.json"), `${JSON.stringify({
            minimumNodeMajor: 24,
            version: "9.8.8-broken"
        }, null, 2)}\n`, "utf8");
        const cli = resolve(app, "dist", "CliMain.js");
        await writeFile(cli, [
            "#!/usr/bin/env node",
            "import './missing-runtime-module.js';",
            ""
        ].join("\n"), "utf8");
        await chmod(cli, 0o755);

        const archive = resolve(release, applicationAssetName());
        run("tar", ["-czf", archive, "-C", app, "."]);
        await writeChecksum(archive);
        for (const target of preinstalledTargets()) {
            const filename = target.startsWith("windows-")
                ? `devshell-worker-${target}.exe`
                : `devshell-worker-${target}`;
            const worker = resolve(release, filename);
            await writeFile(worker, `fake worker ${target}\n`, "utf8");
            await writeChecksum(worker);
        }

        const result = spawnSync("sh", [resolve(repositoryRoot, "scripts", "install-release.sh")], {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                HOME: home,
                XDG_DATA_HOME: resolve(root, "data"),
                PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
                PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
                PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
                PORTABLE_DEVSHELL_HOME: devshellHome
            },
            timeout: 30_000
        });

        assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
        await assert.rejects(lstat(resolve(installRoot, "current")), { code: "ENOENT" });
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Windows release installer activates a fresh application with the host worker", {
    skip: process.platform !== "win32"
}, async () => {
    const root = await createTestTempDirectory("windows-release-install-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const applicationVersion = "9.8.7-windows-test";

    try {
        await mkdir(resolve(app, "custom"), { recursive: true });
        await mkdir(release, { recursive: true });
        await mkdir(home, { recursive: true });
        await writeFile(resolve(app, "package.json"), `${JSON.stringify({
            name: "portable-devshell",
            version: applicationVersion,
            private: true,
            type: "module",
            bin: { devshell: "./custom/devshell-entry.js" },
            engines: { node: ">=24" }
        }, null, 2)}\n`, "utf8");
        await writeFile(resolve(app, "portable-devshell-install.json"), `${JSON.stringify({
            minimumNodeMajor: 24,
            version: applicationVersion
        }, null, 2)}\n`, "utf8");
        await writeFile(resolve(app, "custom", "devshell-entry.js"), [
            "#!/usr/bin/env node",
            "const command = process.argv[2] ?? 'status';",
            "if (command === 'status') process.stdout.write('control: stopped\\n');",
            "else if (command === 'stop') process.exit(0);",
            "else { process.stderr.write(`unsupported test command: ${command}\\n`); process.exit(2); }",
            ""
        ].join("\n"), "utf8");

        const archive = resolve(release, applicationAssetName());
        run("tar.exe", ["-czf", archive, "-C", app, "."]);
        await writeChecksum(archive);
        for (const target of preinstalledTargets()) {
            const filename = target.startsWith("windows-")
                ? `devshell-worker-${target}.exe`
                : `devshell-worker-${target}`;
            const worker = resolve(release, filename);
            await writeFile(worker, `fake worker ${target}\n`, "utf8");
            await writeChecksum(worker);
        }

        const environment = {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            LOCALAPPDATA: resolve(root, "local-app-data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome
        };
        const result = spawnSync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve(repositoryRoot, "scripts", "install-release.ps1")
        ], {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: environment,
            timeout: 30_000
        });
        assert.equal(result.status, 0, `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`);

        const command = resolve(binDirectory, "devshell.cmd");
        const commandResult = spawnSync(command, ["status"], {
            encoding: "utf8",
            env: environment,
            shell: true
        });
        assert.equal(commandResult.status, 0, `${commandResult.stdout}${commandResult.stderr}`);

        for (const target of preinstalledTargets()) {
            const suffix = target.startsWith("windows-") ? ".exe" : "";
            assert.equal((await lstat(resolve(devshellHome, "bin", `devshell-worker-${target}${suffix}`))).isFile(), true);
        }
        for (const target of allTargets.filter((candidate) => !preinstalledTargets().includes(candidate))) {
            const suffix = target.startsWith("windows-") ? ".exe" : "";
            await assert.rejects(lstat(resolve(devshellHome, "bin", `devshell-worker-${target}${suffix}`)), { code: "ENOENT" });
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

async function assertInstalledLayout({ applicationVersion, binDirectory, devshellHome, installRoot }) {
    const current = resolve(installRoot, "current");
    assert.equal(await readlink(current), `versions/${applicationVersion}`);

    const command = resolve(binDirectory, "devshell");
    const commandMetadata = await lstat(command);
    assert.equal(commandMetadata.isSymbolicLink(), true);
    assert.equal(await readlink(command), resolve(current, "custom", "devshell-entry.js"));

    const result = spawnSync(command, ["status"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const installedManifest = JSON.parse(await readFile(resolve(current, "package.json"), "utf8"));
    assert.equal(installedManifest.bin.devshell, "./custom/devshell-entry.js");
    assert.equal(installedManifest.version, applicationVersion);

    for (const target of preinstalledTargets()) {
        const suffix = target.startsWith("windows-") ? ".exe" : "";
        const worker = resolve(devshellHome, "bin", `devshell-worker-${target}${suffix}`);
        assert.equal((await lstat(worker)).isSymbolicLink(), true);
    }
    for (const target of allTargets.filter((candidate) => !preinstalledTargets().includes(candidate))) {
        const suffix = target.startsWith("windows-") ? ".exe" : "";
        await assert.rejects(lstat(resolve(devshellHome, "bin", `devshell-worker-${target}${suffix}`)), { code: "ENOENT" });
    }

    const installManifest = JSON.parse(await readFile(resolve(current, "portable-devshell-install.json"), "utf8"));
    assert.equal(typeof installManifest.workerReleaseDirectoryUrl, "string");
}

function runInstaller(environment) {
    const result = spawnSync("sh", [resolve(repositoryRoot, "scripts", "install-release.sh")], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        timeout: 30_000
    });
    assert.equal(result.status, 0, `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`);
    return result;
}

async function writeChecksum(path) {
    const payload = await readFile(path);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, "utf8");
}

function hostTarget() {
    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    return `${os}-${architecture}`;
}

function preinstalledTargets() {
    return [hostTarget()];
}

function applicationAssetName() {
    return `portable-devshell-app-${hostTarget()}.tar.gz`;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`);
}

test("Unix release installer rolls back application and worker aliases as one transaction", {
    skip: process.platform === "win32"
}, async () => {
    await verifyTransactionalRollback(false);
});

test("Unix release installer restores the previous running runtime after rollback", {
    skip: process.platform === "win32"
}, async () => {
    const root = await createTestTempDirectory("release-runtime-rollback-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const runtimeLog = resolve(root, "runtime.log");
    let oldControl;
    const environment = {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: resolve(root, "data"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
        PORTABLE_DEVSHELL_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
    };

    try {
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: "9.8.7-runtime-old",
            workerContent: "old-worker\n"
        });
        const installed = runInstallerRaw(environment, false);
        assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);

        const oldVersionDirectory = resolve(installRoot, "versions", "9.8.7-runtime-old");
        oldControl = await startFakeControl(oldVersionDirectory, devshellHome);
        await writeTransactionalReleaseFixture({
            app,
            failAfterActivation: true,
            release,
            version: "9.8.8-runtime-broken",
            workerContent: "new-worker\n"
        });
        const failed = runInstallerRaw({
            ...environment,
            PORTABLE_DEVSHELL_TEST_RUNNING: "1",
            PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
        }, false);
        assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
        assert.deepEqual((await readFile(runtimeLog, "utf8")).trim().split("\n"), [
            "stop",
            "start",
            "instance:ready-local",
            "instance:starting-ssh",
            "instance:stale-local",
        ]);
        const restored = JSON.parse(await readFile(resolve(installRoot, "current", "package.json"), "utf8"));
        assert.equal(restored.version, "9.8.7-runtime-old");
    } finally {
        oldControl?.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
});

test("Unix release installer rejects stale activation before stopping a different running Control", {
    skip: process.platform === "win32"
}, async () => {
    const root = await createTestTempDirectory("release-stale-activation-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const runtimeLog = resolve(root, "runtime.log");
    const environment = {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: resolve(root, "data"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
        PORTABLE_DEVSHELL_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
    };
    let liveControl;
    try {
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: "9.8.7-activated",
            workerContent: "old-worker\n"
        });
        const installed = runInstallerRaw(environment, false);
        assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);

        const liveGeneration = resolve(installRoot, "versions", "9.8.9-actually-running");
        liveControl = await startFakeControl(liveGeneration, devshellHome);
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: "9.9.0-candidate",
            workerContent: "new-worker\n"
        });

        const failed = runInstallerRaw({
            ...environment,
            PORTABLE_DEVSHELL_TEST_RUNNING: "1",
            PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
        }, false);
        assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
        assert.match(failed.stderr, /不属于当前激活的 application generation/u);
        const current = JSON.parse(await readFile(resolve(installRoot, "current", "package.json"), "utf8"));
        assert.equal(current.version, "9.8.7-activated");
        assert.equal(await readFile(runtimeLog, "utf8").catch(() => ""), "");
        assert.doesNotThrow(() => process.kill(liveControl.pid, 0));
    } finally {
        liveControl?.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
});

test("Unix release installer rolls back when the candidate Control cannot restore real state", {
    skip: process.platform === "win32"
}, async () => {
    const root = await createTestTempDirectory("release-real-runtime-failure-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const runtimeLog = resolve(root, "runtime.log");
    const environment = {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: resolve(root, "data"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
        PORTABLE_DEVSHELL_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
    };
    let oldControl;
    try {
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: "9.8.7-runtime-old",
            workerContent: "old-worker\n"
        });
        const installed = runInstallerRaw(environment, false);
        assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);

        oldControl = await startFakeControl(resolve(installRoot, "versions", "9.8.7-runtime-old"), devshellHome);
        await writeTransactionalReleaseFixture({
            app,
            failRuntimeRestore: true,
            release,
            version: "9.8.8-runtime-new",
            workerContent: "new-worker\n"
        });
        const failed = runInstallerRaw({
            ...environment,
            PORTABLE_DEVSHELL_TEST_RUNNING: "1",
        }, false);
        assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
        assert.match(failed.stderr, /候选 Control 无法恢复真实运行态/u);
        const current = JSON.parse(await readFile(resolve(installRoot, "current", "package.json"), "utf8"));
        assert.equal(current.version, "9.8.7-runtime-old");
        assert.deepEqual((await readFile(runtimeLog, "utf8")).trim().split("\n"), [
            "stop",
            "candidate-start-failed",
            "stop",
            "start",
            "instance:ready-local",
            "instance:starting-ssh",
            "instance:stale-local",
        ]);
        const workerBackups = (await readdir(devshellHome)).filter((name) => name.startsWith(".install-worker-backup-"));
        assert.equal(workerBackups.length, 0);
    } finally {
        oldControl?.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
});

test("Unix release installer never downgrades after candidate instances may access persistent state", {
    skip: process.platform === "win32"
}, async () => {
    const root = await createTestTempDirectory("release-instance-runtime-failure-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const runtimeLog = resolve(root, "runtime.log");
    const environment = {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: resolve(root, "data"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
        PORTABLE_DEVSHELL_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
    };
    let oldControl;
    try {
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: "9.8.7-instance-old",
            workerContent: "old-worker\n"
        });
        const installed = runInstallerRaw(environment, false);
        assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);

        oldControl = await startFakeControl(resolve(installRoot, "versions", "9.8.7-instance-old"), devshellHome);
        await writeTransactionalReleaseFixture({
            app,
            failInstanceRestore: true,
            release,
            version: "9.8.8-instance-new",
            workerContent: "new-worker\n"
        });
        const failed = runInstallerRaw({
            ...environment,
            PORTABLE_DEVSHELL_TEST_RUNNING: "1",
        }, false);
        assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
        assert.match(failed.stderr, /禁止自动降级/u);
        const current = JSON.parse(await readFile(resolve(installRoot, "current", "package.json"), "utf8"));
        assert.equal(current.version, "9.8.8-instance-new");
        assert.deepEqual((await readFile(runtimeLog, "utf8")).trim().split("\n"), [
            "stop",
            "start",
            "instance:ready-local",
            "instance:starting-ssh",
            "instance:stale-local",
        ]);
        const workerBackups = (await readdir(devshellHome)).filter((name) => name.startsWith(".install-worker-backup-"));
        assert.equal(workerBackups.length, 1);
    } finally {
        oldControl?.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
});

test("Windows release installer rolls back application and worker aliases as one transaction", {
    skip: process.platform !== "win32"
}, async () => {
    await verifyTransactionalRollback(true);
});

test("Windows release installer prepares rollback state before entering Control shutdown", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts", "install-release.ps1"), "utf8");
    const prepare = source.indexOf("    Backup-WorkerAliases $targets $devshellHome $workerBackupDirectory");
    const transaction = source.indexOf("    try {", prepare);
    const shutdown = source.indexOf("        Stop-InstalledControl $currentCli $devshellHome", transaction);
    assert.ok(prepare >= 0, "Worker activation backup must be present");
    assert.ok(transaction > prepare, "rollback scope must start after backup preparation");
    assert.ok(shutdown > transaction, "Control shutdown must execute inside the rollback scope");
});

test("Windows release installer commits only after candidate Control restore", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts", "install-release.ps1"), "utf8");
    const restoreControl = source.indexOf("        Restore-InstalledControl $cliPath $runtimeState");
    const commit = source.indexOf("        $activated = $true", restoreControl);
    const stopCandidate = source.indexOf("                    Stop-InstalledControl $commandPath $devshellHome", restoreControl);
    const restoreInstances = source.indexOf("        Restore-InstalledInstances $cliPath $runtimeState", commit);
    assert.ok(restoreControl >= 0, "candidate Control restore must be present");
    assert.ok(commit > restoreControl, "candidate Control must restore before committing activation");
    assert.ok(stopCandidate > restoreControl, "failed candidate Control must be stopped before rollback");
    assert.ok(restoreInstances > commit, "instance restore must happen only after the rollback boundary closes");
});

async function verifyTransactionalRollback(windows) {
    const root = await createTestTempDirectory(windows
        ? "windows-release-rollback-test"
        : "release-rollback-test");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const environment = {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: resolve(root, "data"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
        PORTABLE_DEVSHELL_HOME: devshellHome,
        ...(windows ? {
            USERPROFILE: home,
            LOCALAPPDATA: resolve(root, "local-app-data")
        } : {})
    };
    const oldVersion = windows ? "9.8.7-old-windows" : "9.8.7-old";
    const brokenVersion = windows
        ? "9.8.8-broken-after-activation-windows"
        : "9.8.8-broken-after-activation";

    try {
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: oldVersion,
            workerContent: "old-worker\n"
        });
        const installed = runInstallerRaw(environment, windows);
        assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);

        const workerAlias = resolve(devshellHome, "bin", workerAssetName());
        const defaultAlias = resolve(devshellHome, "bin", windows ? "devshell-worker.exe" : "devshell-worker");
        assert.equal(await readFile(workerAlias, "utf8"), "old-worker\n");
        assert.equal(await readFile(defaultAlias, "utf8"), "old-worker\n");

        await writeTransactionalReleaseFixture({
            app,
            failAfterActivation: true,
            release,
            version: brokenVersion,
            workerContent: "new-worker\n"
        });
        const failed = runInstallerRaw(environment, windows);
        assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);

        const restored = JSON.parse(await readFile(resolve(installRoot, "current", "package.json"), "utf8"));
        assert.equal(restored.version, oldVersion);
        assert.equal(await readFile(workerAlias, "utf8"), "old-worker\n");
        assert.equal(await readFile(defaultAlias, "utf8"), "old-worker\n");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

async function writeTransactionalReleaseFixture({ app, failAfterActivation = false, failInstanceRestore = false, failRuntimeRestore = false, release, version, workerContent }) {
    await rm(app, { force: true, recursive: true });
    await mkdir(resolve(app, "custom"), { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(resolve(app, "package.json"), `${JSON.stringify({
        name: "portable-devshell",
        version,
        private: true,
        type: "module",
        bin: { devshell: "./custom/devshell-entry.js" },
        engines: { node: ">=24" }
    }, null, 2)}\n`, "utf8");
    await writeFile(resolve(app, "portable-devshell-install.json"), `${JSON.stringify({
        minimumNodeMajor: 24,
        version
    }, null, 2)}\n`, "utf8");
    const cli = resolve(app, "custom", "devshell-entry.js");
    await writeFile(cli, [
        "#!/usr/bin/env node",
        "import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';",
        "const command = process.argv[2] ?? 'status';",
        "const staged = realpathSync(process.argv[1]).includes('.staging-');",
        "const liveHome = process.env.PORTABLE_DEVSHELL_TEST_LIVE_HOME || '';",
        "const running = process.env.PORTABLE_DEVSHELL_TEST_RUNNING === '1' && !staged && process.env.PORTABLE_DEVSHELL_HOME === liveHome;",
        "const runtimeLog = process.env.PORTABLE_DEVSHELL_TEST_RUNTIME_LOG || '';",
        "const pidFile = `${process.env.PORTABLE_DEVSHELL_HOME || ''}/control/control.pid`;",
        "const controlPid = running && existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) : undefined;",
        "const record = (line) => { if (runtimeLog) appendFileSync(runtimeLog, `${line}\\n`); };",
        ...(failAfterActivation ? [
            "if (command === 'status' && !staged) { process.stderr.write('post-activation failure\\n'); process.exit(1); }"
        ] : []),
        "if (command === 'status') process.stdout.write(running ? `control: running\\npid: ${controlPid}\\n` : 'control: stopped\\n');",
        "else if (command === 'overview' && running) process.stdout.write(JSON.stringify({ instances: [",
        "  { name: 'ready-local', snapshot: { daemonState: 'running' } },",
        "  { name: 'starting-ssh', snapshot: { daemonState: 'starting' } },",
        "  { name: 'stale-local', snapshot: { daemonState: 'stale' } },",
        "  { name: 'stopped-local', snapshot: { daemonState: 'stopped' } },",
        "  { name: 'reverse-node', snapshot: { daemonState: 'running', reverse: { connected: true } } }",
        "] }));",
        "else if (command === 'stop') { if (controlPid) process.kill(controlPid, 'SIGTERM'); rmSync(pidFile, { force: true }); record('stop'); }",
        ...(failRuntimeRestore ? [
            "else if (command === 'start') { record('candidate-start-failed'); process.stderr.write('real-state start failure\\n'); process.exit(1); }"
        ] : [
            "else if (command === 'start') record('start');"
        ]),
        ...(failInstanceRestore ? [
            "else if (command === 'instance' && process.argv[3] === 'start') { record(`instance:${process.argv[4]}`); if (process.argv[4] === 'ready-local') { process.stderr.write('instance restore failure\\n'); process.exit(1); } }"
        ] : [
            "else if (command === 'instance' && process.argv[3] === 'start') record(`instance:${process.argv[4]}`);"
        ]),
        "else { process.stderr.write(`unsupported test command: ${command}\\n`); process.exit(2); }",
        ""
    ].join("\n"), "utf8");
    if (process.platform !== "win32") await chmod(cli, 0o755);

    const archive = resolve(release, applicationAssetName());
    run(process.platform === "win32" ? "tar.exe" : "tar", ["-czf", archive, "-C", app, "."]);
    await writeChecksum(archive);
    const worker = resolve(release, workerAssetName());
    await writeFile(worker, workerContent, "utf8");
    await writeChecksum(worker);
}

async function startFakeControl(applicationDirectory, devshellHome) {
    const daemon = resolve(applicationDirectory, "test-runtime", "ControlDaemon.js");
    await mkdir(resolve(applicationDirectory, "test-runtime"), { recursive: true });
    await mkdir(resolve(devshellHome, "control"), { recursive: true });
    await writeFile(daemon, "setInterval(() => {}, 1000);\n", "utf8");
    const child = spawn(process.execPath, [daemon], { stdio: "ignore" });
    await writeFile(resolve(devshellHome, "control", "control.pid"), `${child.pid}\n`, "utf8");
    return child;
}

function runInstallerRaw(environment, windows) {
    const executable = windows ? "powershell.exe" : "sh";
    const args = windows ? [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve(repositoryRoot, "scripts", "install-release.ps1")
    ] : [resolve(repositoryRoot, "scripts", "install-release.sh")];
    return spawnSync(executable, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        timeout: 30_000
    });
}

function workerAssetName() {
    const target = hostTarget();
    return target.startsWith("windows-") ? `devshell-worker-${target}.exe` : `devshell-worker-${target}`;
}
