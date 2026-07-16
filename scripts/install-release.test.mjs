import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const targets = [
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

        const archive = resolve(release, "portable-devshell-app.tar.gz");
        run("tar", ["-czf", archive, "-C", app, "."]);
        await writeChecksum(archive);

        for (const target of targets) {
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
        await assertInstalledLayout({ applicationVersion, binDirectory, devshellHome, installRoot });

        const second = runInstaller(environment);
        assert.match(second.stdout, /已安装 portable-devshell 9\.8\.7-test/u);
        await assertInstalledLayout({ applicationVersion, binDirectory, devshellHome, installRoot });
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

    const hostWorker = resolve(devshellHome, "bin", `devshell-worker-${hostTarget()}`);
    assert.equal((await lstat(hostWorker)).isSymbolicLink(), true);
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
    await writeFile(`${path}.sha256`, `${sha256}  ${path.split("/").at(-1)}\n`, "utf8");
}

function hostTarget() {
    const os = process.platform === "darwin" ? "darwin" : "linux";
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    return `${os}-${architecture}`;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`);
}
