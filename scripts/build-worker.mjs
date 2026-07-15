import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const CARGO_ZIGBUILD_VERSION = "0.23.0";
const ZIG_VERSION = "0.14.1";

const TARGETS = {
    "linux-x64": {
        key: "linux-x64",
        rustTarget: "x86_64-unknown-linux-musl"
    },
    "linux-arm64": {
        key: "linux-arm64",
        rustTarget: "aarch64-unknown-linux-musl"
    },
    "darwin-x64": {
        key: "darwin-x64",
        rustTarget: "x86_64-apple-darwin"
    },
    "darwin-arm64": {
        key: "darwin-arm64",
        rustTarget: "aarch64-apple-darwin"
    },
    "windows-x64": {
        key: "windows-x64",
        rustTarget: "x86_64-pc-windows-msvc"
    },
    "windows-arm64": {
        key: "windows-arm64",
        rustTarget: "aarch64-pc-windows-msvc"
    }
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const explicitTarget = readOption("--target");
const outputDirectory = readOption("--output-dir");

if (args.includes("--zigbuild")) {
    throw new Error("--zigbuild was removed because Linux targets always use cargo zigbuild");
}

const target = explicitTarget === undefined ? detectHostTarget() : resolveTarget(explicitTarget);
const profile = outputDirectory === undefined ? "debug" : "release";
const workerSource = resolveSourcePath(target, profile);
const cargoSubcommand = target.key.startsWith("linux-") ? "zigbuild" : "build";
const buildEnvironment = target.key.startsWith("linux-") ? ensureZigBuild(process.env) : process.env;

run(
    "cargo",
    [
        cargoSubcommand,
        "--locked",
        "-p",
        "devshell-worker",
        "--manifest-path",
        resolve(repoRoot, "Cargo.toml"),
        "--target",
        target.rustTarget,
        ...(profile === "release" ? ["--release"] : [])
    ],
    { env: buildEnvironment }
);

if (!existsSync(workerSource)) {
    throw new Error(`worker binary is missing at ${workerSource}`);
}

if (outputDirectory !== undefined) {
    const outputPath = resolve(outputDirectory, workerAssetName(target));
    const shaPath = `${outputPath}.sha256`;
    const bytes = copyWorker(workerSource, outputPath);
    writeFileSync(shaPath, `${createHash("sha256").update(bytes).digest("hex")}\n`, "utf8");
}

function ensureZigBuild(baseEnvironment) {
    const environment = { ...baseEnvironment };

    if (!commandSucceeds("cargo", ["zigbuild", "--version"], environment)) {
        run(
            "cargo",
            ["install", "--locked", "cargo-zigbuild", "--version", CARGO_ZIGBUILD_VERSION],
            { env: environment }
        );
    }

    if (commandSucceeds("zig", ["version"], environment)) {
        return environment;
    }

    const zigDirectory = installZig();
    environment.PATH = `${zigDirectory}${delimiter}${environment.PATH ?? ""}`;
    if (!commandSucceeds("zig", ["version"], environment)) {
        throw new Error(`Zig ${ZIG_VERSION} was installed but is not executable from ${zigDirectory}`);
    }
    return environment;
}

function installZig() {
    const host = zigHost();
    const cacheRoot = resolve(homedir(), ".cache", "portable-devshell", "toolchains");
    const installDirectory = resolve(cacheRoot, `zig-${ZIG_VERSION}-${host.archivePlatform}-${host.archiveArch}`);
    const executable = resolve(installDirectory, process.platform === "win32" ? "zig.exe" : "zig");
    if (existsSync(executable)) {
        return installDirectory;
    }

    mkdirSync(installDirectory, { recursive: true });
    const archiveName = `zig-${host.archiveArch}-${host.archivePlatform}-${ZIG_VERSION}.tar.xz`;
    const archivePath = resolve(cacheRoot, archiveName);
    const downloadUrl = `https://ziglang.org/download/${ZIG_VERSION}/${archiveName}`;
    run("curl", ["-fsSL", downloadUrl, "-o", archivePath], { env: process.env });
    run("tar", ["-xJf", archivePath, "--strip-components=1", "-C", installDirectory], { env: process.env });
    if (!existsSync(executable)) {
        throw new Error(`Zig archive did not contain the expected executable: ${executable}`);
    }
    return installDirectory;
}

function zigHost() {
    const archivePlatform = process.platform === "darwin" ? "macos" : process.platform;
    const archiveArch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : undefined;
    if (!(["linux", "macos"].includes(archivePlatform)) || archiveArch === undefined) {
        throw new Error(`automatic Zig installation is unsupported on ${process.platform}-${process.arch}`);
    }
    return { archiveArch, archivePlatform };
}

function commandSucceeds(command, args, environment) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env: environment,
        stdio: "ignore"
    });
    return result.status === 0;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        env: options.env,
        cwd: repoRoot,
        stdio: "inherit"
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function readOption(name) {
    const index = args.indexOf(name);
    if (index === -1) {
        return undefined;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
    }

    return value;
}

function resolveSourcePath(target, profile) {
    return resolve(repoRoot, "target", target.rustTarget, profile, workerBinaryName(target));
}

function copyWorker(sourcePath, outputPath) {
    const bytes = readFileSync(sourcePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(sourcePath, outputPath);
    if (!outputPath.endsWith(".exe")) chmodSync(outputPath, 0o755);
    return bytes;
}

function workerBinaryName(target) {
    return target.key.startsWith("windows-") ? "devshell-worker.exe" : "devshell-worker";
}

function workerAssetName(target) {
    return target.key.startsWith("windows-")
        ? `devshell-worker-${target.key}.exe`
        : `devshell-worker-${target.key}`;
}

function detectHostTarget() {
    return resolveTarget(`${normalizeOs(process.platform)}-${normalizeArch(process.arch)}`);
}

function resolveTarget(key) {
    const target = TARGETS[key];
    if (target === undefined) {
        throw new Error(`unsupported worker target: ${key}`);
    }

    return target;
}

function normalizeOs(platform) {
    switch (platform) {
        case "linux":
            return "linux";
        case "darwin":
            return "darwin";
        case "win32":
            return "windows";
        default:
            throw new Error(`unsupported host platform: ${platform}`);
    }
}

function normalizeArch(arch) {
    switch (arch) {
        case "x64":
            return "x64";
        case "arm64":
            return "arm64";
        default:
            throw new Error(`unsupported host architecture: ${arch}`);
    }
}
