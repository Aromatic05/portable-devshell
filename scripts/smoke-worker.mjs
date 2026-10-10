import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { WORKER_PROTOCOL_VERSION } from "../packages/shared/dist/index.js";
import { WorkerBinary } from "../packages/core/dist/instance/runtime/Binary.js";
import { LocalExecution } from "../packages/core/dist/instance/runtime/execution/provider/Local.js";
import { WorkerTerminal } from "../packages/core/dist/instance/runtime/execution/capability/terminal/Terminal.js";
import { TransportConnection } from "../packages/core/dist/instance/transport/endpoint/Connection.js";
import { TransportFactory } from "../packages/core/dist/instance/transport/endpoint/Factory.js";
import { WorkerProtocolClient } from "../packages/core/dist/instance/transport/packet/Client.js";
import { WorkerToolCatalog } from "../packages/core/dist/toolcall/worker/Catalog.js";
import { WorkerToolInvoker } from "../packages/core/dist/toolcall/worker/Invoker.js";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const workerArgument = process.argv[2];
if (workerArgument === undefined) {
    throw new Error("usage: node scripts/smoke-worker.mjs <worker executable>");
}
const worker = isAbsolute(workerArgument)
    ? workerArgument
    : resolve(process.cwd(), workerArgument);
const root = await createTestTempDirectory("worker-smoke");
const workspace = resolve(root, "workspace");
const instance = `worker-smoke-${process.pid}`;
const env = {
    ...process.env,
    PORTABLE_DEVSHELL_HOME: resolve(root, "home"),
};
delete env.DEVSHELL_WORKER_INTERNAL_INSTANCE;
delete env.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
delete env.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
await mkdir(workspace, { recursive: true });

try {
    stage("start worker");
    runWorker(["start", "--instance", instance]);
    stage("open Worker Endpoint");
    const transport = new LocalExecution({
        workerBinary: new WorkerBinary(worker),
    });
    const connection = new TransportConnection(() =>
        transport.connectChannel({ env, instanceName: instance }),
    );
    const workerHost = `${instance}-worker`;
    const endpoint = TransportFactory.createEndpoint(connection, instance, workerHost);
    const protocol = new WorkerProtocolClient(endpoint, workerHost);
    const terminalPort = new WorkerTerminal(endpoint, workerHost);
    const catalog = new WorkerToolCatalog();
    const invoker = new WorkerToolInvoker(endpoint, workerHost, catalog);
    const callTool = (name, input) => invoker.invoke(name, input, { workspace });
    try {
        stage("worker.handshake");
        const handshake = await protocol.handshake({
            clientName: "portable-devshell-smoke",
            clientVersion: "0.0.0",
            protocolRange: {
                max: WORKER_PROTOCOL_VERSION,
                min: WORKER_PROTOCOL_VERSION,
            },
        });
        stage("tools.list");
        const tools = await protocol.listTools();
        catalog.refresh(tools.tools);
        const names = tools.tools.map((tool) => tool.name);
        if (!names.includes("bash_run"))
            throw new Error("bash_run is missing from tools.list");
        if (handshake.platform.os === "windows") {
            for (const name of [
                "tmux_input",
                "tmux_inspect",
                "tmux_manage",
                "tmux_read",
                "tmux_run",
            ]) {
                if (!names.includes(name)) {
                    throw new Error(
                        `Windows worker is missing embedded persistent-pane tool ${name}`,
                    );
                }
            }
            if (handshake.platform.shell?.kind !== "powershell") {
                throw new Error(
                    "Windows handshake did not report the PowerShell runtime",
                );
            }
        }

        stage("file_edit");
        const written = await callTool("file_edit", {
            changes:
                "*** Begin Edit\n*** Write File: ./portable-devshell-smoke.txt\nportable-devshell-file-smoke\n*** End Edit",
        });
        if (
            !Array.isArray(written.operations) ||
            written.operations.length === 0 ||
            written.operations.some(
                (operation) => operation?.status !== "applied",
            )
        ) {
            throw new Error(
                `file_edit smoke failed: ${JSON.stringify(written)}`,
            );
        }
        stage("file_read");
        const read = await callTool("file_read", {
            files: [{ path: "./portable-devshell-smoke.txt" }],
        });
        const readEntry = Array.isArray(read.files) ? read.files[0] : undefined;
        if (
            typeof readEntry?.content !== "string" ||
            !readEntry.content.includes("portable-devshell-file-smoke")
        ) {
            throw new Error(`file_read smoke failed: ${JSON.stringify(read)}`);
        }

        stage("bash_run");
        const command =
            handshake.platform.os === "windows"
                ? "Write-Output 'portable-devshell-smoke'"
                : "printf 'portable-devshell-smoke\\n'";
        const result = await callTool("bash_run", {
            command,
            maxCaptureBytes: 4096,
            timeoutMs: 10_000,
        });
        if (
            result.exitCode !== 0 ||
            !result.stdout.includes("portable-devshell-smoke")
        ) {
            throw new Error(`bash_run smoke failed: ${JSON.stringify(result)}`);
        }

        stage("terminal.open");
        const terminal = await terminalPort.open({
            cols: 80,
            rows: 24,
            workspace,
        });
        const terminalClient = {
            clientSeq: 1,
            fromSeq: 0,
            responseTail: "",
            version: terminal.version,
            windows: handshake.platform.os === "windows",
        };
        if (terminalClient.windows) {
            await waitForTerminalOutput(
                terminalPort,
                terminal,
                terminalClient,
                "\u001B[6n",
            );
        }
        await terminalPort.write({
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: terminalClient.version,
            clientSeq: terminalClient.clientSeq++,
            data: Buffer.from(
                terminalPrintCommand("worker-pty-smoke"),
                "utf8",
            ).toString("base64"),
        });
        await waitForTerminalOutput(
            terminalPort,
            terminal,
            terminalClient,
            "worker-pty-smoke",
        );

        stage("terminal.resize");
        const resized = await terminalPort.resize({
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: terminalClient.version,
            clientSeq: terminalClient.clientSeq++,
            cols: 100,
            rows: 40,
        });
        terminalClient.version = resized.version;
        await terminalPort.write({
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: terminalClient.version,
            clientSeq: terminalClient.clientSeq++,
            data: Buffer.from(terminalSizeProbeCommand(), "utf8").toString(
                "base64",
            ),
        });
        await waitForTerminalOutput(terminalPort, terminal, terminalClient, "40 100");

        stage("terminal.kill");
        await terminalPort.kill({
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: terminalClient.version,
            clientSeq: terminalClient.clientSeq++,
        });
        await waitForTerminalExit(terminalPort, terminal);
    } finally {
        stage("close Worker Endpoint");
        endpoint.close();
        connection.close();
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
        windowsHide: true,
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
        ? `$s=$Host.UI.RawUI.WindowSize; [Console]::WriteLine(('{0} {1}' -f $s.Height,$s.Width))\r`
        : "stty size\r";
}

async function waitForTerminalOutput(terminalPort, terminal, client, expected) {
    const deadline = Date.now() + (client.windows ? 30_000 : 10_000);
    let output = "";
    while (Date.now() < deadline) {
        const attached = await terminalPort.attach({
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            fromSeq: client.fromSeq,
        });
        for (const frame of attached.replay) {
            if (frame.seq <= client.fromSeq) continue;
            client.fromSeq = frame.seq;
            const data = Buffer.from(frame.dataBase64, "base64").toString(
                "utf8",
            );
            output += data;
            if (client.windows) {
                await respondToCursorPositionQueries(
                    terminalPort,
                    terminal,
                    client,
                    data,
                );
            }
        }
        if (output.includes(expected)) return;
        await delay(50);
    }
    throw new Error(
        `terminal output did not include ${expected}: ${JSON.stringify(output)}`,
    );
}

async function respondToCursorPositionQueries(terminalPort, terminal, client, data) {
    const query = "\u001B[6n";
    client.responseTail += data;
    while (true) {
        const queryIndex = client.responseTail.indexOf(query);
        if (queryIndex < 0) {
            client.responseTail = client.responseTail.slice(
                -(query.length - 1),
            );
            return;
        }
        client.responseTail = client.responseTail.slice(
            queryIndex + query.length,
        );
        await terminalPort.write({
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            version: client.version,
            clientSeq: client.clientSeq++,
            data: Buffer.from("\u001B[1;1R", "utf8").toString("base64"),
        });
    }
}

async function waitForTerminalExit(terminalPort, terminal) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const attached = await terminalPort.attach({
            terminalId: terminal.terminalId,
            generation: terminal.generation,
            fromSeq: 0,
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
        windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
        throw new Error(
            `${worker} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
        );
    }
}

async function reportFailure(error) {
    let workerLog = "";
    try {
        workerLog = await readFile(
            resolve(env.PORTABLE_DEVSHELL_HOME, instance, "logs", "worker.log"),
            "utf8",
        );
    } catch {
        // The daemon may fail before the log file exists.
    }
    const rendered = [
        error instanceof Error ? (error.stack ?? error.message) : String(error),
        workerLog.length > 0
            ? `worker.log:\n${workerLog}`
            : "worker.log was unavailable",
    ].join("\n\n");
    process.stderr.write(
        `::error title=Worker smoke::${escapeWorkflowCommand(rendered)}\n`,
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
