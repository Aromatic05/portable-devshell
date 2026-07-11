import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const version = requireString(packageJson.version, "package.json version");
const releaseTag = process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_TAG || `v${version}`;
const releaseBaseUrl = resolveReleaseBaseUrl();
const home = process.env.HOME || homedir();
const dataHome = process.env.XDG_DATA_HOME || resolve(home, ".local", "share");
const installRoot = process.env.PORTABLE_DEVSHELL_INSTALL_ROOT || resolve(dataHome, "portable-devshell");
const binDirectory = process.env.PORTABLE_DEVSHELL_BIN_DIR || resolve(home, ".local", "bin");
const devshellHome = process.env.PORTABLE_DEVSHELL_HOME || resolve(home, ".devshell");
const versionsDirectory = resolve(installRoot, "versions");
const versionDirectory = resolve(versionsDirectory, version);
const stagingDirectory = resolve(installRoot, `.staging-${version}-${process.pid}`);
const backupDirectory = resolve(installRoot, `.backup-${version}-${process.pid}`);
const currentLink = resolve(installRoot, "current");
const commandLink = resolve(binDirectory, "devshell");
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

await rm(stagingDirectory, { force: true, recursive: true });
await rm(backupDirectory, { force: true, recursive: true });
await mkdir(installRoot, { mode: 0o700, recursive: true });

try {
    runPnpm(["build"]);
    runPnpm(["--filter", "@portable-devshell/cli", "--prod", "deploy", stagingDirectory]);
    await chmod(resolve(stagingDirectory, "dist", "cli", "CliMain.js"), 0o755);

    const installedWorkers = {};
    for (const target of targets) {
        installedWorkers[target] = await installWorker(target);
    }

    await writeFile(
        resolve(stagingDirectory, "portable-devshell-install.json"),
        `${JSON.stringify({ releaseTag, version, workers: installedWorkers }, null, 2)}\n`,
        { mode: 0o600 }
    );

    await stopInstalledControl();
    await mkdir(versionsDirectory, { mode: 0o700, recursive: true });

    if (await pathExists(versionDirectory)) {
        await rename(versionDirectory, backupDirectory);
    }

    try {
        await rename(stagingDirectory, versionDirectory);
        await replaceSymlink(currentLink, `versions/${version}`);
        await mkdir(binDirectory, { recursive: true });
        await replaceSymlink(commandLink, resolve(currentLink, "dist", "cli", "CliMain.js"));
    } catch (error) {
        await rm(versionDirectory, { force: true, recursive: true });
        if (await pathExists(backupDirectory)) {
            await rename(backupDirectory, versionDirectory);
        }
        throw error;
    }

    await rm(backupDirectory, { force: true, recursive: true });
    process.stdout.write(`Installed portable-devshell ${version}.\nCommand: ${commandLink}\n`);
} catch (error) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
}

async function installWorker(target) {
    const assetName = `devshell-worker-${target}`;
    const releaseDirectory = `${releaseBaseUrl}/${releaseTag}`;
    const expectedSha = await fetchSha256(`${releaseDirectory}/${assetName}.sha256`);
    const installDirectory = resolve(devshellHome, "workers", target, expectedSha);
    const binaryPath = resolve(installDirectory, "devshell-worker");
    const shaPath = resolve(installDirectory, "devshell-worker.sha256");

    await mkdir(installDirectory, { mode: 0o700, recursive: true });
    if ((await readInstalledSha(binaryPath, shaPath)) !== expectedSha) {
        const payload = Buffer.from(await fetchBytes(`${releaseDirectory}/${assetName}`));
        const actualSha = createHash("sha256").update(payload).digest("hex");
        if (actualSha !== expectedSha) {
            throw new Error(`Checksum mismatch for ${assetName}: expected ${expectedSha}, got ${actualSha}.`);
        }

        const temporaryBinary = `${binaryPath}.tmp-${process.pid}`;
        const temporarySha = `${shaPath}.tmp-${process.pid}`;
        await writeFile(temporaryBinary, payload, { mode: 0o755 });
        await chmod(temporaryBinary, 0o755);
        await writeFile(temporarySha, `${expectedSha}\n`, { mode: 0o600 });
        await rename(temporaryBinary, binaryPath);
        await rename(temporarySha, shaPath);
    }

    const workerBinDirectory = resolve(devshellHome, "bin");
    await mkdir(workerBinDirectory, { mode: 0o700, recursive: true });
    await replaceSymlink(
        resolve(workerBinDirectory, assetName),
        `../workers/${target}/${expectedSha}/devshell-worker`
    );

    if (target === hostTarget()) {
        await replaceSymlink(resolve(workerBinDirectory, "devshell-worker"), assetName);
    }

    return { path: binaryPath, sha256: expectedSha };
}

async function stopInstalledControl() {
    const currentCli = resolve(currentLink, "dist", "cli", "CliMain.js");
    if (!(await pathExists(currentCli))) {
        return;
    }

    const result = spawnSync(process.execPath, [currentCli, "stop"], {
        cwd: home,
        encoding: "utf8",
        env: process.env
    });
    if (result.status !== 0) {
        throw new Error(`Failed to stop the installed control before activation.\n${result.stderr || result.stdout}`);
    }
}

function runPnpm(args) {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const result = spawnSync(command, args, { cwd: repoRoot, env: process.env, stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
    }
}

async function fetchSha256(url) {
    const text = Buffer.from(await fetchBytes(url)).toString("utf8");
    const sha = text.trim().split(/\s+/u)[0] || "";
    if (!/^[a-f0-9]{64}$/u.test(sha)) {
        throw new Error(`Invalid SHA-256 document from ${url}.`);
    }
    return sha;
}

async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
    }
    return await response.arrayBuffer();
}

async function readInstalledSha(binaryPath, shaPath) {
    try {
        const [binary, recorded] = await Promise.all([readFile(binaryPath), readFile(shaPath, "utf8")]);
        const actual = createHash("sha256").update(binary).digest("hex");
        return actual === recorded.trim() ? actual : undefined;
    } catch {
        return undefined;
    }
}

async function replaceSymlink(path, target) {
    const temporary = `${path}.tmp-${process.pid}`;
    await rm(temporary, { force: true });
    await symlink(target, temporary);
    await rename(temporary, path).catch(async (error) => {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
            throw error;
        }
        await rm(path, { force: true });
        await rename(temporary, path);
    });
}

async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function resolveReleaseBaseUrl() {
    const explicit = process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL;
    if (explicit) {
        return explicit.replace(/\/+$/u, "");
    }
    const repository = process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY || "Aromatic05/portable-devshell";
    return `https://github.com/${repository.replace(/^\/+|\/+$/gu, "")}/releases/download`;
}

function hostTarget() {
    const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : undefined;
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
    if (!os || !arch) {
        throw new Error(`Unsupported installation host: ${process.platform}-${process.arch}.`);
    }
    return `${os}-${arch}`;
}

function requireString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${name} must be a non-empty string.`);
    }
    return value;
}
