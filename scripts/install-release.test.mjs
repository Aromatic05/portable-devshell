import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
test("PowerShell release installer is UTF-8 with BOM for Windows PowerShell", async () => {
    const content = await readFile(resolve(repositoryRoot, "scripts", "install-release.ps1"));
    assert.deepEqual([...content.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const source = content.toString("utf8");
    assert.doesNotMatch(source, /Get-FileHash/u);
    assert.match(source, /Security\.Cryptography\.SHA256/u);
    assert.match(source, /IsNullOrWhiteSpace\(\$CurrentCli\).*Test-Path -LiteralPath \$CurrentCli/u);
});

test("Unix release installer braces variables before Chinese punctuation", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts", "install-release.sh"), "utf8");
    assert.doesNotMatch(source, /\$[A-Za-z_][A-Za-z0-9_]*[：。]/u);
});

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
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-release-install-test-"));
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

        const first = runInstaller(environment);
        assert.match(first.stdout, /已安装 portable-devshell 9\.8\.7-test/u);
        assert.match(first.stdout, /\[1\/6\] 检查安装环境/u);
        assert.match(first.stdout, /\[2\/6\] 下载应用包/u);
        assert.match(first.stdout, /\[3\/6\] 下载预装 Worker/u);
        assert.match(first.stdout, /\[6\/6\] 验证安装结果/u);
        await assertInstalledLayout({ applicationVersion, binDirectory, devshellHome, installRoot });

        const second = runInstaller(environment);
        assert.match(second.stdout, /已安装 portable-devshell 9\.8\.7-test/u);
        await assertInstalledLayout({ applicationVersion, binDirectory, devshellHome, installRoot });
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Unix release installer rejects an application that cannot start before activation", {
    skip: process.platform === "win32"
}, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-release-broken-test-"));
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
        assert.match(`${result.stdout}${result.stderr}`, /安装前验证失败/u);
        await assert.rejects(lstat(resolve(installRoot, "current")), { code: "ENOENT" });
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Windows release installer activates a fresh application with the host worker", {
    skip: process.platform !== "win32"
}, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-windows-release-install-test-"));
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
        assert.match(result.stdout, /\[1\/6\]/u);
        assert.match(result.stdout, /portable-devshell 9\.8\.7-windows-test/u);

        const command = resolve(binDirectory, "devshell.cmd");
        const commandResult = spawnSync(command, ["status"], {
            encoding: "utf8",
            env: environment,
            shell: true
        });
        assert.equal(commandResult.status, 0, `${commandResult.stdout}${commandResult.stderr}`);
        assert.match(commandResult.stdout, /control: stopped/u);

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
    assert.match(result.stdout, /control: stopped/u);

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

test("Windows installer smoke allows slower ARM package activation", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts", "smoke-install-release-windows.mjs"), "utf8");
    assert.match(source, /install-release\.ps1"\)\r?\n\s*\], false, false, 180_000\);/u);
    assert.match(source, /timeoutMs = 45_000/u);
});
