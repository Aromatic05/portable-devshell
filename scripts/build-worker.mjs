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
const useZigbuild = args.includes("--zigbuild");

const target = explicitTarget === undefined ? detectHostTarget() : resolveTarget(explicitTarget);
const profile = outputDirectory === undefined ? "debug" : "release";
const workerSource = resolveSourcePath(target, profile);

if (useZigbuild && !target.key.startsWith("linux-")) {
    throw new Error("--zigbuild is only supported for Linux worker targets");
}

run(
    "cargo",
    [
        useZigbuild ? "zigbuild" : "build",
        "-p",
        "devshell-worker",
        "--manifest-path",
        resolve(repoRoot, "Cargo.toml"),
        "--target",
        target.rustTarget,
        ...(profile === "release" ? ["--release"] : [])
    ],
    {
        env: {
            ...process.env,
            ...(useZigbuild ? {} : buildCargoTargetEnv(target))
        }
    }
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

function buildCargoTargetEnv(target) {
    if (target.key !== "linux-x64" && target.key !== "linux-arm64") {
        return {};
    }

    const rustLld = resolveRustLld();
    const envKey =
        target.key === "linux-x64"
            ? "CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER"
            : "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER";

    return rustLld === undefined ? {} : { [envKey]: rustLld };
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

function resolveRustLld() {
    const sysrootResult = spawnSync("rustc", ["--print", "sysroot"], {
        cwd: repoRoot,
        encoding: "utf8"
    });
    const versionResult = spawnSync("rustc", ["-vV"], {
        cwd: repoRoot,
        encoding: "utf8"
    });

    if (sysrootResult.status !== 0 || versionResult.status !== 0) {
        return undefined;
    }

    const sysroot = sysrootResult.stdout.trim();
    const hostLine = versionResult.stdout
        .split("\n")
        .find((line) => line.startsWith("host: "));

    if (sysroot.length === 0 || hostLine === undefined) {
        return undefined;
    }

    const rustLld = resolve(sysroot, "lib", "rustlib", hostLine.slice("host: ".length).trim(), "bin", "rust-lld");
    return existsSync(rustLld) ? rustLld : undefined;
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
