import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AgentToolSession, AgentWorkerTarget } from "@portable-devshell/agentd";
import { parseAgentWorkerTarget } from "@portable-devshell/agentd";
import { PiAgentProcessFactory } from "../../src/PiAgentProcess.ts";

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
        await first.reload?.();
        await second.steer?.("second");
        await first.stop();

        let entries = await readEntries(runtimeDirectory);
        assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
        assert.equal(entries.filter((entry) => entry.type === "init").length, 1);
        assert.equal(entries.filter((entry) => entry.type === "agent.start").length, 2);
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
            /IPC.*disconnect/u
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
        target,
        tools
    };
}

function toolSession(
    target: AgentWorkerTarget,
    overrides: Partial<Pick<AgentToolSession, "callTool" | "close">> = {}
): AgentToolSession {
    let closed = false;
    return {
        target,
        tools: [
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
        ],
        callTool: overrides.callTool ?? (async (_toolName, input) => input),
        async close() {
            if (closed) return;
            closed = true;
            await overrides.close?.();
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
    pid: string;
    type: string;
}>> {
    const text = await readFile(join(runtimeDirectory, "fake-pi-child.log"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => {
        const [pid, stateDir, type, agentId, command] = line.split("\t");
        return {
            agentDir: stateDir ?? "",
            agentId: agentId ?? "",
            command: command ?? "",
            pid: pid ?? "",
            type: type ?? ""
        };
    });
}
