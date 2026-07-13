import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerArgument = process.argv[2];
if (workerArgument === undefined) {
    throw new Error("usage: node scripts/smoke-client.mjs <worker executable>");
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = resolve(repositoryRoot, "packages", "cli", "dist", "cli", "CliMain.js");
const worker = isAbsolute(workerArgument) ? workerArgument : resolve(process.cwd(), workerArgument);
const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-client-smoke-"));
const home = resolve(root, "user");
const devshellHome = resolve(home, ".devshell");
const workspace = resolve(root, "workspace");
const runtime = resolve(root, "runtime");
const instance = `client-smoke-${process.pid}`;
const userIdentity = `devshell-smoke-${process.pid}`;
const targetKey = resolveTargetKey(process.platform, process.arch);
const workerEnvName = `PORTABLE_DEVSHELL_WORKER_${targetKey.replaceAll("-", "_").toUpperCase()}_PATH`;
const env = {
    ...process.env,
    HOME: home,
    USER: userIdentity,
    USERNAME: userIdentity,
    USERPROFILE: home,
    LOCALAPPDATA: resolve(root, "local-app-data"),
    PORTABLE_DEVSHELL_HOME: devshellHome,
    XDG_RUNTIME_DIR: runtime,
    [workerEnvName]: worker
};

delete env.DEVSHELL_WORKER_INTERNAL_INSTANCE;
delete env.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
delete env.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;

await mkdir(resolve(devshellHome, "control", "instances"), { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(runtime, { recursive: true });
await writeFile(
    resolve(devshellHome, "control", "config.toml"),
    [
        "version = 1",
        "",
        "[control]",
        'logLevel = "info"',
        "",
        "[mcp]",
        "enabled = false",
        'listenHost = "127.0.0.1"',
        "listenPort = 17890",
        'publicBaseUrl = "http://127.0.0.1:17890"',
        "",
        "[mcp.auth]",
        'mode = "none"',
        ""
    ].join("\n"),
    "utf8"
);

await writeFile(
    resolve(devshellHome, "control", "instances", `${instance}.toml`),
    [
        "version = 2",
        `name = ${tomlString(instance)}`,
        "enabled = true",
        'provider = "local"',
        `workspace = ${tomlString(workspace)}`,
        "",
        "[mcp]",
        "enabled = false",
        "",
        "[mcp.tools]",
        'groups = ["file", "bash", "artifact", "todo"]',
        'capabilities = ["read", "write", "execute"]',
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

let controlStarted = false;
let instanceStarted = false;
try {
    runCli(["start"]);
    controlStarted = true;

    const status = runCli(["status"]);
    if (!status.stdout.includes("control: running")) {
        throw new Error(`control status did not report running:\n${status.stdout}${status.stderr}`);
    }

    runCli(["instance", "start", instance]);
    instanceStarted = true;

    const instanceStatus = runCli(["instance", "status", instance]);
    if (!instanceStatus.stdout.includes("ready: true")) {
        throw new Error(`instance status did not report ready:\n${instanceStatus.stdout}${instanceStatus.stderr}`);
    }

    const command =
        process.platform === "win32"
            ? "Write-Output 'portable-devshell-client-smoke'"
            : "printf 'portable-devshell-client-smoke\\n'";
    const call = runCli(["instance", "call", instance, "bash_run", JSON.stringify({ command })]);
    if (!call.stdout.includes("portable-devshell-client-smoke")) {
        throw new Error(`client tool call did not return expected output:\n${call.stdout}${call.stderr}`);
    }

    runCli(["instance", "stop", instance]);
    instanceStarted = false;
    runCli(["stop"]);
    controlStarted = false;
    process.stdout.write("client smoke passed\n");
} finally {
    if (instanceStarted) {
        runCli(["instance", "stop", instance], true);
    }
    if (controlStarted) {
        runCli(["stop"], true);
    }
    await rm(root, { force: true, recursive: true });
}

function runCli(args, ignoreFailure = false) {
    const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: workspace,
        encoding: "utf8",
        env
    });
    if (!ignoreFailure && result.status !== 0) {
        throw new Error(
            `devshell ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.stdout ?? ""}${result.stderr ?? ""}`
        );
    }
    return {
        status: result.status,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? ""
    };
}

function resolveTargetKey(platform, architecture) {
    const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
    const arch = architecture === "x64" ? "x64" : architecture === "arm64" ? "arm64" : undefined;
    if (os === undefined || arch === undefined) {
        throw new Error(`unsupported client smoke platform: ${platform}-${architecture}`);
    }
    return `${os}-${arch}`;
}

function tomlString(value) {
    return JSON.stringify(value);
}
