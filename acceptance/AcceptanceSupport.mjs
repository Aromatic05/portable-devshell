import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const sourceLoader = resolve(repoRoot, "packages", "mcp", "test", "RegisterWorkspacePackages.mjs");
export const cliEntry = resolve(repoRoot, "packages", "cli", "src", "CliMain.ts");

export function resolvePreparedWorker() {
    const configured = process.env.PORTABLE_DEVSHELL_TEST_WORKER_PATH;
    const targetDirectory = process.env.CARGO_TARGET_DIR;
    const path = configured && configured.length > 0
        ? resolve(repoRoot, configured)
        : resolve(
            targetDirectory && targetDirectory.length > 0
                ? resolve(repoRoot, targetDirectory)
                : resolve(repoRoot, "target"),
            "debug",
            `devshell-worker${process.platform === "win32" ? ".exe" : ""}`
        );
    if (!existsSync(path)) {
        throw new Error(
            `missing prepared worker: ${path}\n` +
            "run `pnpm test:prepare` first or set PORTABLE_DEVSHELL_TEST_WORKER_PATH"
        );
    }
    return path;
}

export function workerEnvironmentName(platform = process.platform, arch = process.arch) {
    const os = { darwin: "DARWIN", linux: "LINUX", win32: "WINDOWS" }[platform];
    const cpu = { arm64: "ARM64", x64: "X64" }[arch];
    if (!os || !cpu) throw new Error(`unsupported acceptance host: ${platform}-${arch}`);
    return `PORTABLE_DEVSHELL_WORKER_${os}_${cpu}_PATH`;
}

export async function createAcceptanceFixture() {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-acceptance-"));
    const home = join(root, "home");
    const runtime = join(root, "runtime");
    const workspace = join(root, "workspace");
    await Promise.all([
        mkdir(join(home, ".devshell", "control", "instances"), { recursive: true }),
        mkdir(runtime, { recursive: true }),
        mkdir(workspace, { recursive: true })
    ]);
    await writeFile(join(workspace, "README.md"), "portable-devshell acceptance workspace\n", "utf8");
    const port = await reservePort();
    const globalConfig = [
        "version = 1",
        "",
        "[control]",
        'logLevel = "info"',
        "",
        "[mcp]",
        "enabled = true",
        'listenHost = "127.0.0.1"',
        `listenPort = ${port}`,
        `publicBaseUrl = "http://127.0.0.1:${port}"`,
        "",
        "[mcp.auth]",
        'mode = "none"',
        ""
    ].join("\n");
    const instanceConfig = [
        "version = 2",
        'name = "aromatic-pc"',
        "enabled = true",
        'provider = "local"',
        `workspace = ${JSON.stringify(workspace)}`,
        "",
        "[mcp]",
        "enabled = true",
        "",
        "[mcp.tools]",
        'groups = ["bash"]',
        'capabilities = ["execute"]',
        "",
        "[logs]",
        "eventBufferSize = 50",
        ""
    ].join("\n");
    await writeFile(join(home, ".devshell", "control", "config.toml"), globalConfig, "utf8");
    await writeFile(join(home, ".devshell", "control", "instances", "aromatic-pc.toml"), instanceConfig, "utf8");

    const worker = resolvePreparedWorker();
    const env = {
        ...process.env,
        HOME: home,
        LOCALAPPDATA: runtime,
        PORTABLE_DEVSHELL_HOME: join(home, ".devshell"),
        USERPROFILE: home,
        XDG_RUNTIME_DIR: runtime,
        ...(process.platform === "win32" ? { USERNAME: `portable-devshell-${process.pid}` } : {}),
        [workerEnvironmentName()]: worker
    };
    return {
        env,
        home,
        port,
        root,
        runtime,
        worker,
        workspace,
        async cleanup() {
            runCli(["instance", "stop", "aromatic-pc"], env, { allowFailure: true });
            runCli(["stop"], env, { allowFailure: true });
            await rm(root, { force: true, recursive: true });
        }
    };
}

export function runCli(args, env, options = {}) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(sourceLoader).href, cliEntry, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true
    });
    if (!options.allowFailure && result.status !== 0) {
        throw new Error(
            `devshell ${args.join(" ")} failed with ${String(result.status)}\n` +
            `${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`
        );
    }
    return result;
}

export function commandAvailable(command, args = []) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env: process.env,
        stdio: "ignore",
        windowsHide: true
    });
    return result.status === 0;
}

export function runCommand(command, args, options = {}) {
    const windowsPnpm = process.platform === "win32" && command === "pnpm";
    const executable = windowsPnpm ? process.env.ComSpec ?? "cmd.exe" : command;
    const commandArgs = windowsPnpm
        ? ["/d", "/s", "/c", ["pnpm", ...args].map(quoteWindowsCommandArgument).join(" ")]
        : args;
    const result = spawnSync(executable, commandArgs, {
        cwd: options.cwd ?? repoRoot,
        encoding: "utf8",
        env: options.env ?? process.env,
        stdio: options.inherit ? "inherit" : "pipe",
        timeout: options.timeoutMs,
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed with ${String(result.status)}\n` +
            `${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`
        );
    }
    return result;
}

function quoteWindowsCommandArgument(value) {
    if (/^[A-Za-z0-9_./:=+-]+$/u.test(value)) return value;
    return `"${String(value).replaceAll('"', '""')}"`;
}

export function assertOutput(result, pattern, label) {
    assert.match(String(result.stdout ?? ""), pattern, label);
}

export function readAuditCollections(path) {
    const require = createRequire(import.meta.url);
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning, ...args) => {
        if (String(warning instanceof Error ? warning.message : warning).includes("SQLite")) return;
        Reflect.apply(originalEmitWarning, process, [warning, ...args]);
    });
    const { DatabaseSync } = require("node:sqlite");
    process.emitWarning = originalEmitWarning;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
        return database.prepare("SELECT collection, payload FROM audit_records ORDER BY id ASC").all();
    } finally {
        database.close();
    }
}

export async function assertControlLog(home) {
    const log = await readFile(join(home, ".devshell", "control", "logs", "control.log"), "utf8");
    assert.match(log, /control server started/u);
}

async function reservePort() {
    const server = createServer();
    await new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
    if (!address || typeof address === "string") throw new Error("failed to reserve acceptance TCP port");
    return address.port;
}
