import { fork, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertPackageBinFile, readPackageBinPath } from "./application-layout.mjs";
import { resolveAgentSmokeArtifacts } from "./smoke-artifact-arguments.mjs";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

if (process.platform === "win32") {
    throw new Error("smoke-agent-package.mjs currently validates the Unix release path.");
}

const [appArchive, extensionBundle, piProviderBundle, openCodeProviderBundle, worker] = resolveAgentSmokeArtifacts(process.argv.slice(2));
const root = await createTestTempDirectory("agent-package-smoke");
const appDirectory = resolve(root, "app");
const home = resolve(root, "home");
const runtime = resolve(root, "runtime");
const devshellHome = resolve(home, ".devshell");
const instance = "agent-smoke";
const workspace = resolve(root, "workspace");
const workerEnvName = `PORTABLE_DEVSHELL_WORKER_${hostTargetKey()}_PATH`;
const environment = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: resolve(root, "data"),
    XDG_RUNTIME_DIR: runtime,
    PORTABLE_DEVSHELL_HOME: devshellHome,
    [workerEnvName]: worker
};
let controlStarted = false;

try {
    await Promise.all([
        mkdir(appDirectory, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(runtime, { mode: 0o700, recursive: true }),
        mkdir(resolve(devshellHome, "control", "instances"), { recursive: true }),
        mkdir(workspace, { recursive: true })
    ]);
    await writeFile(
        resolve(devshellHome, "control", "config.toml"),
        [
            "version = 2",
            "",
            "[control]",
            'logLevel = "info"',
            "",
            "[mcp]",
            "enabled = false",
            'listenHost = "127.0.0.1"',
            "listenPort = 17890",
            'publicBaseUrl = "http://127.0.0.1:17890"',
            ""
        ].join("\n"),
        "utf8"
    );
    await writeFile(
        resolve(devshellHome, "control", "instances", `${instance}.toml`),
        [
            "version = 4",
            `name = ${JSON.stringify(instance)}`,
            "enabled = true",
            'provider = "local"',
            "",
            "[mcp]",
            "enabled = false",
            "",
            "[approvalPolicy]",
            'mode = "disabled"',
            "",
            "[security]",
            'mode = "workspace"',
            ""
        ].join("\n"),
        "utf8"
    );
    run("tar", ["-xzf", appArchive, "-C", appDirectory], environment);
    const cli = await assertPackageBinFile(await readPackageBinPath(appDirectory, "devshell"));
    const pi = await assertPackageBinFile(await readPackageBinPath(appDirectory, "pi"));

    run(process.execPath, [cli.absolutePath, "start"], environment);
    controlStarted = true;
    run(process.execPath, [cli.absolutePath, "extension", "install", extensionBundle], environment);
    run(process.execPath, [cli.absolutePath, "agent", "provider", "install", piProviderBundle], environment);
    run(process.execPath, [cli.absolutePath, "agent", "provider", "install", openCodeProviderBundle], environment);

    const providers = JSON.parse(run(
        process.execPath,
        [cli.absolutePath, "agent", "provider", "list"],
        environment
    ).stdout);
    const piProvider = Array.isArray(providers)
        ? providers.find((provider) => provider?.id === "pi")
        : undefined;
    if (piProvider?.enabled !== true || piProvider?.state !== "ready") {
        throw new Error(`installed Pi provider is not ready: ${JSON.stringify(piProvider)}`);
    }
    const openCodeProvider = Array.isArray(providers)
        ? providers.find((provider) => provider?.id === "opencode")
        : undefined;
    if (openCodeProvider?.enabled !== true || openCodeProvider?.state !== "ready") {
        throw new Error(`installed OpenCode provider is not ready: ${JSON.stringify(openCodeProvider)}`);
    }

    const piVersion = run(process.execPath, [pi.absolutePath, "--version"], environment).stdout.trim();
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(piVersion)) {
        throw new Error(`packaged Pi launcher returned an invalid version: ${JSON.stringify(piVersion)}`);
    }
    smokePiAgentLifecycle(cli.absolutePath, environment);
    const openCodeVersion = await smokeOpenCodeProvider(openCodeProvider, environment);

    run(process.execPath, [cli.absolutePath, "stop"], environment);
    controlStarted = false;
    process.stdout.write(`Agent package smoke passed (Pi ${piVersion}, OpenCode ${openCodeVersion})\n`);
} finally {
    if (controlStarted) {
        run(process.execPath, [resolve(appDirectory, (await readPackageBinPath(appDirectory, "devshell")).relativePath), "stop"], environment, true);
    }
    await rm(root, { force: true, recursive: true });
}

function hostTargetKey() {
    const os = process.platform === "darwin" ? "DARWIN" : process.platform === "win32" ? "WINDOWS" : "LINUX";
    const arch = process.arch === "arm64" ? "ARM64" : process.arch === "x64" ? "X64" : undefined;
    if (arch === undefined) throw new Error(`unsupported host architecture: ${process.arch}`);
    return `${os}_${arch}`;
}

function run(executable, args, env, ignoreFailure = false) {
    const result = spawnSync(executable, args, {
        cwd: root,
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

function smokePiAgentLifecycle(cli, env) {
    const target = `${instance}:${workspace}`;
    const started = JSON.parse(run(
        process.execPath,
        [cli, "agent", "--provider", "pi", target],
        env
    ).stdout);
    if (started?.provider !== "pi" || started?.state !== "running" || typeof started?.agentId !== "string") {
        throw new Error(`Pi Agent did not start through the packaged provider: ${JSON.stringify(started)}`);
    }

    const listed = JSON.parse(run(process.execPath, [cli, "agent", "list"], env).stdout);
    if (!Array.isArray(listed) || !listed.some((agent) => agent?.agentId === started.agentId && agent?.provider === "pi")) {
        throw new Error(`started Pi Agent is missing from list: ${JSON.stringify(listed)}`);
    }

    run(process.execPath, [cli, "agent", "stop", started.agentId], env);
    const afterStop = JSON.parse(run(process.execPath, [cli, "agent", "list"], env).stdout);
    if (Array.isArray(afterStop) && afterStop.some((agent) => agent?.agentId === started.agentId)) {
        throw new Error(`stopped Pi Agent is still listed: ${JSON.stringify(afterStop)}`);
    }
}

async function smokeOpenCodeProvider(provider, env) {
    const generation = provider?.selectedGeneration;
    if (typeof generation !== "string" || generation.length === 0) {
        throw new Error(`installed OpenCode provider has no selected generation: ${JSON.stringify(provider)}`);
    }
    const providerDirectory = resolve(
        env.XDG_DATA_HOME,
        "portable-devshell",
        "extension-data",
        "agent",
        "bundles",
        generation
    );
    const installerModule = await import(pathToFileURL(resolve(
        providerDirectory,
        "dist/provider/opencode/OpenCodeProviderInstaller.js"
    )).href);
    const installation = await new installerModule.OpenCodeProviderInstaller({
        version: installerModule.OPENCODE_RUNTIME_VERSION
    }).ensureInstalled({
        installationDirectory: resolve(root, "unused-opencode-install"),
        providerDirectory: resolve(root, "unused-opencode-provider"),
        stateDirectory: resolve(root, "opencode-state")
    });
    if (!installation.command.startsWith(`${providerDirectory}/`)) {
        throw new Error(`packaged OpenCode provider escaped its private bundle: ${installation.command}`);
    }
    const version = run(installation.command, ["--version"], env).stdout.trim();
    if (version !== installerModule.OPENCODE_RUNTIME_VERSION) {
        throw new Error(`packaged OpenCode runtime returned ${JSON.stringify(version)}`);
    }
    await smokeOpenCodeChild(providerDirectory, installation.command, env);
    return version;
}

async function smokeOpenCodeChild(providerDirectory, command, env) {
    const child = fork(resolve(providerDirectory, "dist/provider/opencode/OpenCodeAgentChild.js"), ["10000"], {
        cwd: root,
        env,
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    try {
        child.send({
            command,
            id: "smoke-init",
            localCwd: resolve(root, "opencode-workspace"),
            modelTools: [],
            stateDirectory: resolve(root, "opencode-state"),
            type: "init"
        });
        const ready = await nextChildMessage(child, (message) => message?.type === "ready" && message.id === "smoke-init", stderr);
        if (ready.ok !== true) throw new Error(`packaged OpenCode ACP init failed: ${JSON.stringify(ready)}\n${stderr}`);
        child.send({ command: "stop", id: "smoke-stop", type: "command" });
        const stopped = await nextChildMessage(child, (message) => message?.type === "result" && message.id === "smoke-stop", stderr);
        if (stopped.ok !== true) throw new Error(`packaged OpenCode ACP stop failed: ${JSON.stringify(stopped)}\n${stderr}`);
        child.disconnect();
        await waitForChildExit(child);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
}

function nextChildMessage(child, predicate, stderr) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`timed out waiting for packaged OpenCode child\n${stderr}`));
        }, 30_000);
        const cleanup = () => {
            clearTimeout(timeout);
            child.off("message", onMessage);
            child.off("exit", onExit);
        };
        const onMessage = (message) => {
            if (!predicate(message)) return;
            cleanup();
            resolve(message);
        };
        const onExit = (code, signal) => {
            cleanup();
            reject(new Error(`packaged OpenCode child exited early (${code ?? signal ?? "unknown"})\n${stderr}`));
        };
        child.on("message", onMessage);
        child.once("exit", onExit);
    });
}

function waitForChildExit(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("packaged OpenCode child did not exit after disconnect"));
        }, 5_000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
}
