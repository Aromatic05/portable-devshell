import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const CARGO_ZIGBUILD_VERSION = "0.23.0";
const ZIG_VERSION = "0.14.1";
const CARGO_COMMAND = readCommandSpec("PORTABLE_DEVSHELL_BUILD_CARGO", "cargo");
const ZIG_COMMAND = readCommandSpec("PORTABLE_DEVSHELL_BUILD_ZIG", "zig");

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
const explicitTarget = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : undefined;
const optionArgs = explicitTarget === undefined ? args : args.slice(1);
const outputDirectory = readOption(optionArgs, "--output-dir");
assertNoUnknownOptions(optionArgs, ["--output-dir"]);

const target = explicitTarget === undefined ? detectHostTarget() : resolveTarget(explicitTarget);
const workerSource = resolveSourcePath(target, "release");
const cargoSubcommand = target.key.startsWith("linux-") ? "zigbuild" : "build";
const buildEnvironment = target.key.startsWith("linux-") ? ensureZigBuild(process.env) : process.env;

run(
    CARGO_COMMAND,
    [
        cargoSubcommand,
        "--locked",
        "-p",
        "devshell-worker",
        "--manifest-path",
        resolve(repoRoot, "Cargo.toml"),
        "--target",
        target.rustTarget,
        "--release"
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

    if (!commandSucceeds(CARGO_COMMAND, ["zigbuild", "--version"], environment)) {
        run(
            CARGO_COMMAND,
            ["install", "--locked", "cargo-zigbuild", "--version", CARGO_ZIGBUILD_VERSION],
            { env: environment }
        );
    }

    if (commandSucceeds(ZIG_COMMAND, ["version"], environment)) {
        return environment;
    }

    const zigDirectory = installZig();
    environment.PATH = `${zigDirectory}${delimiter}${environment.PATH ?? ""}`;
    if (!commandSucceeds(ZIG_COMMAND, ["version"], environment)) {
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
    const spec = normalizeCommandSpec(command);
    const result = spawnSync(spec.command, [...spec.args, ...args], {
        cwd: repoRoot,
        env: environment,
        stdio: "ignore"
    });
    return result.status === 0;
}

function run(command, args, options = {}) {
    const spec = normalizeCommandSpec(command);
    const result = spawnSync(spec.command, [...spec.args, ...args], {
        env: options.env,
        cwd: repoRoot,
        stdio: "inherit"
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function readCommandSpec(environmentName, fallback) {
    const configured = process.env[environmentName];
    if (configured === undefined || configured.length === 0) {
        return { args: [], command: fallback };
    }
    let parsed;
    try {
        parsed = JSON.parse(configured);
    } catch (error) {
        throw new Error(`${environmentName} must be a JSON string array`, { cause: error });
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== "string" || value.length === 0)) {
        throw new Error(`${environmentName} must be a non-empty JSON string array`);
    }
    return { args: parsed.slice(1), command: parsed[0] };
}

function normalizeCommandSpec(command) {
    return typeof command === "string" ? { args: [], command } : command;
}

function readOption(values, name) {
    const index = values.indexOf(name);
    if (index === -1) {
        return undefined;
    }

    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
    }

    return value;
}

function assertNoUnknownOptions(values, supportedOptions) {
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (!value.startsWith("--")) continue;
        if (!supportedOptions.includes(value)) {
            throw new Error(`unsupported option: ${value}`);
        }
        index += 1;
    }
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
