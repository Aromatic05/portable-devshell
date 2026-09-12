import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveApplicationSmokeArchive } from "./smoke-artifact-arguments.mjs";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
if (process.platform === "win32") {
    throw new Error("smoke-install-release.mjs currently validates the Unix release installer.");
}

const archive = resolveApplicationSmokeArchive(process.argv.slice(2));
const archiveSha = `${archive}.sha256`;
const root = await createTestTempDirectory("release-install-smoke");
const release = resolve(root, "release");
const home = resolve(root, "home");
const runtime = resolve(root, "runtime");
const installRoot = resolve(root, "install");
const binDirectory = resolve(root, "bin");
const devshellHome = resolve(root, "devshell-home");
const command = resolve(binDirectory, "devshell");
const piCommand = resolve(binDirectory, "pi");
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
        const source = resolve(dirname(archive), asset);
        for (const path of [source, `${source}.sha256`]) {
            await copyFile(path, resolve(release, basename(path)));
        }
    }

    run("sh", [resolve(repositoryRoot, "scripts", "install-release.sh")], environment);

    run(command, ["start"], environment);
    controlStarted = true;
    run(command, ["status"], environment);
    run(command, ["logs"], environment);
    const piBeforeProvider = run(piCommand, ["--version"], environment, true);
    if (piBeforeProvider.status === 0 || !`${piBeforeProvider.stdout}${piBeforeProvider.stderr}`.includes("devshell agent provider install")) {
        throw new Error("release-installed pi launcher did not report the expected missing-provider guidance");
    }
    run(command, ["stop"], environment);
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
        timeout: 60_000
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
