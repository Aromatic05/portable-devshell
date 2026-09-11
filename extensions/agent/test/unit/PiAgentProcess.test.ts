import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type {
    ExtensionJsonValue,
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionProcessExit,
    ExtensionProcessStartInput
} from "@portable-devshell/extension";

import type { AgentToolSession } from "../../src/builtin/provider/AgentToolSession.ts";
import { PiAgentProcessFactory } from "../../src/provider/pi/PiAgentProcess.ts";
import { parseAgentWorkerTarget, type AgentWorkerTarget } from "../../src/builtin/worker/AgentWorkerTarget.ts";

const childModulePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/FakePiAgentChild.mjs");

test("Pi process factory shares one child across live Agents and stops it only after the last Agent", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-shared-"));
    const piAgentDir = join(runtimeDirectory, "user-pi-state");
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = { entrypoint: "/managed/pi/dist/index.js", runtimeDirectory, webBasePath: "/web/agent/" };

    try {
        const firstTarget = parseAgentWorkerTarget("worker-a:/repo/a");
        const secondTarget = parseAgentWorkerTarget("worker-a:/repo/b");
        const first = await factory.start(startOptions(base, "ag-one", firstTarget));
        const second = await factory.start(startOptions(base, "ag-two", secondTarget));

        assert.equal(first.web?.upstream.toString(), "http://127.0.0.1:43199/");
        assert.equal(second.web?.upstream.toString(), first.web?.upstream.toString());
        await first.prompt("first");
        await first.waitForIdle?.();
        await first.reload?.();
        await second.steer?.("second");
        await first.stop();

        let entries = await readEntries(runtimeDirectory);
        assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
        assert.equal(entries.filter((entry) => entry.type === "init").length, 1);
        assert.equal(entries.filter((entry) => entry.type === "agent.start").length, 2);
        assert.equal(entries.filter((entry) => entry.command === "wait").length, 1);
        assert.equal(entries.filter((entry) => entry.command === "reload").length, 1);
        assert.equal(entries.some((entry) => entry.type === "shutdown"), false);
        assert.ok(entries.every((entry) => entry.agentDir === piAgentDir));

        await second.stop();
        entries = await readEntries(runtimeDirectory);
        assert.equal(entries.filter((entry) => entry.type === "shutdown").length, 1);
        assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
    } finally {
        if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
        await rm(runtimeDirectory, { force: true, recursive: true });
    }
});

test("Pi process forwards child tool calls, cancellation, and close to the parent-held session", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-tools-"));
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = { entrypoint: "/managed/pi/dist/index.js", runtimeDirectory, webBasePath: "/web/agent/" };
    const target = parseAgentWorkerTarget("worker-a:/repo/tools");
    const calls: Array<{ input: unknown; operationId: string; toolName: string }> = [];
    let closes = 0;
    let cancellationObserved = false;
    const tools = toolSession(target, {
        async callTool(toolName, input, operationId, signal) {
            calls.push({ input, operationId, toolName });
            if (toolName === "slow_tool") {
                await new Promise<void>((resolve, reject) => {
                    const aborted = () => {
                        cancellationObserved = true;
                        reject(signal?.reason instanceof Error ? signal.reason : new Error("cancelled"));
                    };
                    if (signal?.aborted) aborted();
                    else signal?.addEventListener("abort", aborted, { once: true });
                });
            }
            return { echoed: input };
        },
        close() { closes += 1; }
    });

    try {
        const handle = await factory.start(startOptions(base, "ag-tools", target, tools));
        await handle.prompt("__tool__");
        assert.deepEqual(calls[0], {
            input: { value: "from-child" },
            operationId: "fake-operation",
            toolName: "echo_tool"
        });

        await handle.prompt("__tool-cancel__");
        assert.equal(cancellationObserved, true);
        assert.equal(calls[1]?.toolName, "slow_tool");

        await handle.stop();
        assert.equal(closes, 1);
    } finally {
        await rm(runtimeDirectory, { force: true, recursive: true });
    }
});

test("Pi process factory retires a crashed shared child and starts a replacement", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-crash-"));
    const piAgentDir = join(runtimeDirectory, "user-pi-state");
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = { entrypoint: "/managed/pi/dist/index.js", runtimeDirectory, webBasePath: "/web/agent/" };

    try {
        const firstTarget = parseAgentWorkerTarget("worker-a:/repo/a");
        const first = await factory.start(startOptions(base, "ag-crash", firstTarget));

        await assert.rejects(() => first.prompt("__crash__"), /(exited unexpectedly|IPC disconnected unexpectedly)/u);
        await first.closed;

        const secondTarget = parseAgentWorkerTarget("worker-a:/repo/b");
        const second = await factory.start(startOptions(base, "ag-replacement", secondTarget));
        await second.prompt("replacement works");

        const entries = await readEntries(runtimeDirectory);
        const initPids = entries.filter((entry) => entry.type === "init").map((entry) => entry.pid);
        assert.equal(initPids.length, 2);
        assert.equal(new Set(initPids).size, 2);

        await second.stop();
    } finally {
        if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
        await rm(runtimeDirectory, { force: true, recursive: true });
    }
});

test("Pi process factory retires a child whose IPC disconnects without process exit", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-disconnect-"));
    const piAgentDir = join(runtimeDirectory, "user-pi-state");
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = { entrypoint: "/managed/pi/dist/index.js", runtimeDirectory, webBasePath: "/web/agent/" };
    let first;

    try {
        const firstTarget = parseAgentWorkerTarget("worker-a:/repo/a");
        first = await factory.start(startOptions(base, "ag-disconnect", firstTarget));

        await assert.rejects(
            Promise.race([first.prompt("__disconnect__"), rejectAfter(200, "IPC disconnect was not observed")]),
            /(exited unexpectedly|IPC.*disconnect)/u
        );
        await first.closed;

        const replacementTarget = parseAgentWorkerTarget("worker-a:/repo/b");
        const replacement = await factory.start(startOptions(base, "ag-after-disconnect", replacementTarget));
        await replacement.prompt("replacement works");
        await replacement.stop();

        const entries = await readEntries(runtimeDirectory);
        assert.equal(new Set(entries.filter((entry) => entry.type === "init").map((entry) => entry.pid)).size, 2);
    } finally {
        await first?.stop().catch(() => undefined);
        if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
        await rm(runtimeDirectory, { force: true, recursive: true });
    }
});

test("Pi provider child does not inherit Extension sandbox permission flags", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-execargv-"));
    const previousExecArgv = [...process.execArgv];
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = { entrypoint: "/managed/pi/dist/index.js", runtimeDirectory, webBasePath: "/web/agent/" };
    try {
        process.execArgv.push(
            "--permission",
            "--allow-fs-read=*",
            "--allow-fs-write=*",
            "--allow-child-process",
            "--allow-worker"
        );
        const target = parseAgentWorkerTarget("worker-a:/repo/execargv");
        const handle = await factory.start(startOptions(base, "ag-execargv", target));
        await handle.stop();

        const init = (await readEntries(runtimeDirectory)).find((entry) => entry.type === "init");
        assert.ok(init !== undefined);
        assert.equal(init.execArgv.some((argument) => argument === "--permission" || argument.startsWith("--allow-")), false);
    } finally {
        process.execArgv.splice(0, process.execArgv.length, ...previousExecArgv);
        await rm(runtimeDirectory, { force: true, recursive: true });
    }
});

function startOptions(
    base: { entrypoint: string; runtimeDirectory: string; webBasePath: string },
    agentId: string,
    target: AgentWorkerTarget,
    tools: AgentToolSession = toolSession(target)
) {
    return {
        ...base,
        agentId,
        localCwd: join(base.runtimeDirectory, "agents", agentId, "cwd"),
        processes: nodeProcessCapability(),
        target,
        tools
    };
}

function toolSession(
    target: AgentWorkerTarget,
    overrides: Partial<Pick<AgentToolSession, "callTool" | "close">> = {}
): AgentToolSession {
    let isClosed = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const tools = [
        {
            description: "Echo a value",
            inputSchema: { type: "object" },
            name: "echo_tool"
        },
        {
            description: "Wait for cancellation",
            inputSchema: { type: "object" },
            name: "slow_tool"
        }
    ];
    return {
        closed,
        modelTools: tools,
        target,
        tools,
        callTool: overrides.callTool ?? (async (_toolName, input) => input),
        async close() {
            if (isClosed) return;
            isClosed = true;
            await overrides.close?.();
            resolveClosed();
        }
    };
}

function nodeProcessCapability(): ExtensionProcessCapability {
    return {
        async start(input: ExtensionProcessStartInput): Promise<ExtensionManagedProcess> {
            const child = spawn(input.command, [...(input.args ?? [])], {
                cwd: input.cwd,
                env: { ...process.env, ...(input.environment ?? {}) },
                serialization: "json",
                stdio: input.messages
                    ? ["ignore", "ignore", "pipe", "ipc"]
                    : ["ignore", "ignore", "pipe"]
            });
            const messageListeners = new Set<(message: ExtensionJsonValue) => void>();
            const stderrListeners = new Set<(chunk: string) => void>();
            let settled = false;
            let resolveClosed!: (exit: ExtensionProcessExit) => void;
            const closed = new Promise<ExtensionProcessExit>((resolve) => { resolveClosed = resolve; });
            const settle = (exit: ExtensionProcessExit) => {
                if (settled) return;
                settled = true;
                messageListeners.clear();
                stderrListeners.clear();
                resolveClosed(Object.freeze({ ...exit }));
            };
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk: string) => {
                for (const listener of stderrListeners) listener(chunk);
            });
            child.on("message", (message: unknown) => {
                for (const listener of messageListeners) listener(message as ExtensionJsonValue);
            });
            child.once("disconnect", () => {
                if (input.messages && !settled) child.kill("SIGTERM");
            });
            child.once("error", () => settle({}));
            child.once("exit", (code, signal) => settle({
                ...(code === null ? {} : { code }),
                ...(signal === null ? {} : { signal })
            }));
            return Object.freeze({
                closed,
                onMessage(listener: (message: ExtensionJsonValue) => void) {
                    messageListeners.add(listener);
                    return () => messageListeners.delete(listener);
                },
                onStderr(listener: (chunk: string) => void) {
                    stderrListeners.add(listener);
                    return () => stderrListeners.delete(listener);
                },
                async send(message: ExtensionJsonValue) {
                    if (!child.connected || child.send === undefined) {
                        throw new Error("Test managed process message channel is unavailable.");
                    }
                    const send = child.send as (
                        value: unknown,
                        callback: (error: Error | null) => void
                    ) => boolean;
                    await new Promise<void>((resolve, reject) => {
                        send.call(child, message, (error) => error === null ? resolve() : reject(error));
                    });
                },
                async terminate(signal = "SIGTERM") {
                    if (settled) return;
                    child.kill(signal as NodeJS.Signals);
                    await closed;
                }
            });
        }
    };
}

function rejectAfter(milliseconds: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message)), milliseconds);
    });
}

async function readEntries(runtimeDirectory: string): Promise<Array<{
    agentDir: string;
    agentId: string;
    command: string;
    execArgv: string[];
    pid: string;
    type: string;
}>> {
    const text = await readFile(join(runtimeDirectory, "fake-pi-child.log"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => {
        const [pid, stateDir, type, agentId, command, execArgv] = line.split("\t");
        return {
            agentDir: stateDir ?? "",
            agentId: agentId ?? "",
            command: command ?? "",
            execArgv: execArgv === undefined ? [] : JSON.parse(execArgv) as string[],
            pid: pid ?? "",
            type: type ?? ""
        };
    });
}
