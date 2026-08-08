import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const workerArgument = process.argv[2];
if (workerArgument === undefined) {
    throw new Error("usage: node scripts/smoke-worker.mjs <worker executable>");
}
const worker = isAbsolute(workerArgument) ? workerArgument : resolve(process.cwd(), workerArgument);
const root = await createTestTempDirectory("worker-smoke");
const workspace = resolve(root, "workspace");
const instance = `windows-smoke-${process.pid}`;
const env = {
    ...process.env,
    DEVSHELL_WORKER_DIAGNOSTIC_RPC: "1",
    PORTABLE_DEVSHELL_HOME: resolve(root, "home")
};
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
            maxProtocolVersion: 3,
            minProtocolVersion: 3
        });
        stage("tools.list");
        const tools = await rpc.request("tools.list", {});
        const names = tools.tools.map((tool) => tool.name);
        if (!names.includes("bash_run")) throw new Error("bash_run is missing from tools.list");
        if (handshake.platform.os === "windows" && names.some((name) => name.startsWith("tmux_"))) {
            throw new Error("Windows worker exposed tmux tools");
        }
        if (handshake.platform.os === "windows") {
            if (handshake.platform.shell?.kind !== "powershell") {
                throw new Error("Windows handshake did not report the PowerShell runtime");
            }
        }

        stage("file_edit");
        const written = await rpc.request("file_edit", {
            changes: "*** Begin Edit\n*** Write File: ./portable-devshell-smoke.txt\nportable-devshell-file-smoke\n*** End Edit"
        });
        if (!Array.isArray(written.operations) || written.operations.length === 0 ||
            written.operations.some((operation) => operation?.status !== "applied")) {
            throw new Error(`file_edit smoke failed: ${JSON.stringify(written)}`);
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

        stage("terminal.open");
        const terminalCapabilities = handshake.capabilities?.terminalPty;
        if (terminalCapabilities?.supported !== true || terminalCapabilities.resize !== true ||
            terminalCapabilities.replay !== true) {
            throw new Error(`worker did not advertise PTY support: ${JSON.stringify(terminalCapabilities)}`);
        }
        const terminal = await rpc.request("terminal.open", { cols: 80, rows: 24 });
        await rpc.request("terminal.write", {
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: terminal.version,
            clientSeq: 1,
            data: Buffer.from(terminalPrintCommand("worker-pty-smoke"), "utf8").toString("base64")
        });
        await waitForTerminalOutput(rpc, terminal, "worker-pty-smoke");

        stage("terminal.resize");
        const resized = await rpc.request("terminal.resize", {
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: terminal.version,
            clientSeq: 2,
            cols: 100,
            rows: 40
        });
        await rpc.request("terminal.write", {
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: resized.version,
            clientSeq: 3,
            data: Buffer.from(terminalSizeProbeCommand(), "utf8").toString("base64")
        });
        await waitForTerminalOutput(rpc, terminal, "40 100");

        stage("terminal.kill");
        await rpc.request("terminal.kill", {
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: resized.version,
            clientSeq: 4
        });
        await waitForTerminalExit(rpc, terminal);
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
} catch (error) {
    await reportFailure(error);
    throw error;
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

function terminalPrintCommand(marker) {
    if (!/^[A-Za-z0-9._-]{2,128}$/u.test(marker)) {
        throw new Error(`invalid terminal marker: ${marker}`);
    }
    const middle = Math.floor(marker.length / 2);
    const left = marker.slice(0, middle);
    const right = marker.slice(middle);
    return process.platform === "win32"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::WriteLine(('${left}' + '${right}'))"\r`
        : `printf '%s%s\\n' '${left}' '${right}'\r`;
}

function terminalSizeProbeCommand() {
    return process.platform === "win32"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$s=$Host.UI.RawUI.WindowSize; [Console]::WriteLine(('{0} {1}' -f $s.Height,$s.Width))"\r`
        : "stty size\r";
}

async function waitForTerminalOutput(rpc, terminal, expected) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const attached = await rpc.request("terminal.attach", {
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            fromSeq: 0
        });
        const output = attached.replay
            .map((frame) => Buffer.from(frame.dataBase64, "base64").toString("utf8"))
            .join("");
        if (output.includes(expected)) return;
        await delay(50);
    }
    throw new Error(`terminal output did not include ${expected}`);
}

async function waitForTerminalExit(rpc, terminal) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const attached = await rpc.request("terminal.attach", {
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            fromSeq: 0
        });
        if (attached.exit !== undefined) return;
        await delay(50);
    }
    throw new Error("terminal did not exit after kill");
}

function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

async function reportFailure(error) {
    let workerLog = "";
    try {
        workerLog = await readFile(
            resolve(env.PORTABLE_DEVSHELL_HOME, instance, "logs", "worker.log"),
            "utf8"
        );
    } catch {
        // The daemon may fail before the log file exists.
    }
    const rendered = [
        error instanceof Error ? error.stack ?? error.message : String(error),
        workerLog.length > 0 ? `worker.log:\n${workerLog}` : "worker.log was unavailable"
    ].join("\n\n");
    process.stderr.write(
        `::error title=Windows worker smoke::${escapeWorkflowCommand(rendered)}\n`
    );
}

function escapeWorkflowCommand(value) {
    return value
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
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
