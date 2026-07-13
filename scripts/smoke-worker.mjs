import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const workerArgument = process.argv[2];
if (workerArgument === undefined) {
    throw new Error("usage: node scripts/smoke-worker.mjs <worker executable>");
}
const worker = isAbsolute(workerArgument) ? workerArgument : resolve(process.cwd(), workerArgument);
const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-worker-smoke-"));
const workspace = resolve(root, "workspace");
const instance = `windows-smoke-${process.pid}`;
const env = { ...process.env, PORTABLE_DEVSHELL_HOME: resolve(root, "home") };
delete env.DEVSHELL_WORKER_INTERNAL_INSTANCE;
delete env.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
delete env.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
await mkdir(workspace, { recursive: true });

try {
    stage("start worker");
    runWorker(["start", "--instance", instance]);
    stage("open rpc bridge");
    const bridge = spawn(worker, ["rpc", "--instance", instance], {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "pipe"]
    });
    const rpc = createRpcClient(bridge);
    try {
        stage("worker.handshake");
        const handshake = await rpc.request("worker.handshake", {
            clientName: "portable-devshell-smoke",
            clientVersion: "0.0.0",
            maxProtocolVersion: 2,
            minProtocolVersion: 2
        });
        stage("tools.list");
        const tools = await rpc.request("tools.list", {});
        const names = tools.tools.map((tool) => tool.name);
        if (!names.includes("bash_run")) throw new Error("bash_run is missing from tools.list");
        if (handshake.platform.os === "windows" && names.some((name) => name.startsWith("tmux_"))) {
            throw new Error("Windows worker exposed tmux tools");
        }
        if (handshake.platform.os === "windows") {
            const description = tools.tools.find((tool) => tool.name === "bash_run")?.description ?? "";
            if (!description.includes("PowerShell") || !description.includes("PowerShell syntax")) {
                throw new Error(`Windows bash_run description is not PowerShell-specific: ${description}`);
            }
            if (handshake.platform.shell?.kind !== "powershell") {
                throw new Error("Windows handshake did not report the PowerShell runtime");
            }
        }

        stage("file_write");
        const written = await rpc.request("file_write", {
            content: "portable-devshell-file-smoke\n",
            path: "./portable-devshell-smoke.txt"
        });
        if (typeof written.revision !== "string" || written.revision.length === 0) {
            throw new Error(`file_write smoke failed: ${JSON.stringify(written)}`);
        }
        stage("file_read");
        const read = await rpc.request("file_read", { path: "./portable-devshell-smoke.txt" });
        if (typeof read.content !== "string" || !read.content.includes("portable-devshell-file-smoke")) {
            throw new Error(`file_read smoke failed: ${JSON.stringify(read)}`);
        }

        stage("bash_run");
        const command =
            handshake.platform.os === "windows"
                ? "Write-Output 'portable-devshell-smoke'"
                : "printf 'portable-devshell-smoke\\n'";
        const result = await rpc.request("bash_run", {
            command,
            maxCaptureBytes: 4096,
            timeoutMs: 10_000
        });
        if (result.exitCode !== 0 || !result.stdout.includes("portable-devshell-smoke")) {
            throw new Error(`bash_run smoke failed: ${JSON.stringify(result)}`);
        }
    } finally {
        stage("close rpc bridge");
        bridge.stdin.end();
        await Promise.race([
            new Promise((done) => bridge.once("exit", done)),
            new Promise((done) => setTimeout(done, 2_000))
        ]);
        if (bridge.exitCode === null) bridge.kill();
    }

    stage("stop worker");
    runWorker(["stop", "--instance", instance]);
    process.stdout.write("worker smoke passed\n");
} finally {
    spawnSync(worker, ["stop", "--instance", instance], {
        cwd: workspace,
        env,
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true
    });
    await rm(root, { force: true, recursive: true });
}

function runWorker(args) {
    const result = spawnSync(worker, args, {
        cwd: workspace,
        env,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true
    });
    if (result.error !== undefined || result.status !== 0) {
        throw new Error(
            `${worker} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`
        );
    }
}

function stage(message) {
    process.stdout.write(`[smoke-worker] ${message}\n`);
}

function createRpcClient(child) {
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (buffer.length < length + 4) return;
            const payload = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
            buffer = buffer.subarray(length + 4);
            const request = pending.get(payload.id);
            if (request === undefined) continue;
            pending.delete(payload.id);
            clearTimeout(request.timer);
            if (payload.ok) request.resolve(payload.result);
            else request.reject(new Error(JSON.stringify(payload.error)));
        }
    });
    child.once("exit", (code) => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(`worker rpc bridge exited with ${code}: ${stderr}`));
        }
        pending.clear();
    });

    return {
        request(method, params) {
            const id = `smoke-${nextId++}`;
            const payload = Buffer.from(JSON.stringify({ type: "request", id, method, params }), "utf8");
            const frame = Buffer.allocUnsafe(payload.length + 4);
            frame.writeUInt32BE(payload.length, 0);
            payload.copy(frame, 4);
            return new Promise((resolvePromise, rejectPromise) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    rejectPromise(new Error(`worker rpc timeout for ${method}: ${stderr}`));
                }, 15_000);
                pending.set(id, { reject: rejectPromise, resolve: resolvePromise, timer });
                child.stdin.write(frame);
            });
        }
    };
}
