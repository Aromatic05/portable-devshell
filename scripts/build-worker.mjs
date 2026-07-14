import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
    { env: process.env }
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
