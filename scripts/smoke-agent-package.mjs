import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { assertPackageBinFile, readPackageBinPath } from "./application-layout.mjs";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const inputs = process.argv.slice(2).filter((argument) => argument !== "--");
if (inputs.length !== 3) {
    throw new Error("usage: node scripts/smoke-agent-package.mjs <app.tar.gz> <agent.dsext> <pi.dsprovider>");
}
if (process.platform === "win32") {
    throw new Error("smoke-agent-package.mjs currently validates the Unix release path.");
}

const [appArgument, extensionArgument, providerArgument] = inputs;
const appArchive = absoluteInput(appArgument);
const extensionBundle = absoluteInput(extensionArgument);
const providerBundle = absoluteInput(providerArgument);
const root = await createTestTempDirectory("agent-package-smoke");
const appDirectory = resolve(root, "app");
const home = resolve(root, "home");
const runtime = resolve(root, "runtime");
const devshellHome = resolve(home, ".devshell");
const environment = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: resolve(root, "data"),
    XDG_RUNTIME_DIR: runtime,
    PORTABLE_DEVSHELL_HOME: devshellHome
};
let controlStarted = false;

try {
    await Promise.all([
        mkdir(appDirectory, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(runtime, { mode: 0o700, recursive: true })
    ]);
    run("tar", ["-xzf", appArchive, "-C", appDirectory], environment);
    const cli = await assertPackageBinFile(await readPackageBinPath(appDirectory, "devshell"));
    const pi = await assertPackageBinFile(await readPackageBinPath(appDirectory, "pi"));

    run(process.execPath, [cli.absolutePath, "start"], environment);
    controlStarted = true;
    run(process.execPath, [cli.absolutePath, "extension", "install", extensionBundle], environment);
    run(process.execPath, [cli.absolutePath, "agent", "provider", "install", providerBundle], environment);

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

    const piVersion = run(process.execPath, [pi.absolutePath, "--version"], environment).stdout.trim();
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(piVersion)) {
        throw new Error(`packaged Pi launcher returned an invalid version: ${JSON.stringify(piVersion)}`);
    }

    run(process.execPath, [cli.absolutePath, "stop"], environment);
    controlStarted = false;
    process.stdout.write(`Agent package smoke passed (Pi ${piVersion})\n`);
} finally {
    if (controlStarted) {
        run(process.execPath, [resolve(appDirectory, (await readPackageBinPath(appDirectory, "devshell")).relativePath), "stop"], environment, true);
    }
    await rm(root, { force: true, recursive: true });
}

function absoluteInput(value) {
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
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
