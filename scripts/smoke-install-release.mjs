import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const archiveArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (archiveArgument === undefined) {
    throw new Error("usage: node scripts/smoke-install-release.mjs <portable-devshell-app.tar.gz>");
}
if (process.platform === "win32") {
    throw new Error("smoke-install-release.mjs currently validates the Unix release installer.");
}

const archive = isAbsolute(archiveArgument) ? archiveArgument : resolve(process.cwd(), archiveArgument);
const archiveSha = `${archive}.sha256`;
const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-release-install-smoke-"));
const release = resolve(root, "release");
const home = resolve(root, "home");
const runtime = resolve(root, "runtime");
const installRoot = resolve(root, "install");
const binDirectory = resolve(root, "bin");
const devshellHome = resolve(root, "devshell-home");
const command = resolve(binDirectory, "devshell");
const environment = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: resolve(root, "data"),
    XDG_RUNTIME_DIR: runtime,
    PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
    PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
    PORTABLE_DEVSHELL_HOME: devshellHome,
    PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, "")
};
let controlStarted = false;

try {
    await mkdir(release, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { recursive: true });
    const applicationAsset = `portable-devshell-app-${hostTarget()}.tar.gz`;
    await copyFile(archive, resolve(release, applicationAsset));
    await copyFile(archiveSha, resolve(release, `${applicationAsset}.sha256`));

    for (const target of preinstalledTargets()) {
        const asset = target.startsWith("windows-")
            ? `devshell-worker-${target}.exe`
            : `devshell-worker-${target}`;
        const path = resolve(release, asset);
        await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
        await chmod(path, 0o755);
        const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
        await writeFile(`${path}.sha256`, `${sha256}  ${asset}\n`, "utf8");
    }

    const install = run("sh", [resolve(repositoryRoot, "scripts", "install-release.sh")], environment);
    assert.match(install.stdout, /已安装 portable-devshell/u);
    assert.match(install.stdout, /CLI 入口和运行时依赖验证通过/u);
    assert.match(install.stdout, /已安装命令可以正常启动/u);

    assertOutput(run(command, ["start"], environment), "control: running", "installed control start");
    controlStarted = true;
    assertOutput(run(command, ["status"], environment), "control: running", "installed control status");
    assertOutput(run(command, ["logs"], environment), "control server started", "installed control logs");
    assertOutput(run(command, ["stop"], environment), "control: stopped", "installed control stop");
    controlStarted = false;

    process.stdout.write("release installer smoke passed\n");
} finally {
    if (controlStarted) {
        run(command, ["stop"], environment, true);
    }
    await rm(root, { force: true, recursive: true });
}

function preinstalledTargets() {
    return [hostTarget()];
}

function hostTarget() {
    const os = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return `${os}-${arch}`;
}

function run(executable, args, env, ignoreFailure = false) {
    const result = spawnSync(executable, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env,
        timeout: 30_000
    });
    if (!ignoreFailure && (result.error !== undefined || result.status !== 0)) {
        throw new Error(
            `${executable} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`
        );
    }
    return {
        status: result.status,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? ""
    };
}

function assertOutput(result, expected, stage) {
    if (result.status !== 0 || !result.stdout.includes(expected)) {
        throw new Error(`${stage} did not contain ${JSON.stringify(expected)}\n${result.stdout}${result.stderr}`);
    }
}
