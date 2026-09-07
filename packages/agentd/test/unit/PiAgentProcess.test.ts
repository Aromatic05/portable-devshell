import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PiAgentProcessFactory } from "../../src/provider/pi/PiAgentProcess.ts";
import { parseAgentWorkerTarget } from "../../src/target/AgentWorkerTarget.ts";

test("Pi process factory shares one child across live Agents and stops it only after the last Agent", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-shared-"));
    const piAgentDir = join(runtimeDirectory, "user-pi-state");
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    const childModulePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/FakePiAgentChild.mjs");
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = {
        entrypoint: "/managed/pi/dist/index.js",
        runtimeDirectory,
        webBasePath: "/web/agent/"
    };

    try {
        const first = await factory.start({
            ...base,
            agentId: "ag-one",
            localCwd: join(runtimeDirectory, "agents", "ag-one", "cwd"),
            target: parseAgentWorkerTarget("worker-a:/repo/a")
        });
        const second = await factory.start({
            ...base,
            agentId: "ag-two",
            localCwd: join(runtimeDirectory, "agents", "ag-two", "cwd"),
            target: parseAgentWorkerTarget("worker-a:/repo/b")
        });

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

test("Pi process factory retires a crashed shared child and starts a replacement", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-crash-"));
    const piAgentDir = join(runtimeDirectory, "user-pi-state");
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    const childModulePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/FakePiAgentChild.mjs");
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = {
        entrypoint: "/managed/pi/dist/index.js",
        runtimeDirectory,
        webBasePath: "/web/agent/"
    };

    try {
        const first = await factory.start({
            ...base,
            agentId: "ag-crash",
            localCwd: join(runtimeDirectory, "agents", "ag-crash", "cwd"),
            target: parseAgentWorkerTarget("worker-a:/repo/a")
        });

        await assert.rejects(() => first.prompt("__crash__"), /(exited unexpectedly|IPC disconnected unexpectedly)/u);
        await first.closed;

        const second = await factory.start({
            ...base,
            agentId: "ag-replacement",
            localCwd: join(runtimeDirectory, "agents", "ag-replacement", "cwd"),
            target: parseAgentWorkerTarget("worker-a:/repo/b")
        });
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
    const childModulePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/FakePiAgentChild.mjs");
    const factory = new PiAgentProcessFactory({ childModulePath });
    const base = {
        entrypoint: "/managed/pi/dist/index.js",
        runtimeDirectory,
        webBasePath: "/web/agent/"
    };
    let first;

    try {
        first = await factory.start({
            ...base,
            agentId: "ag-disconnect",
            localCwd: join(runtimeDirectory, "agents", "ag-disconnect", "cwd"),
            target: parseAgentWorkerTarget("worker-a:/repo/a")
        });

        await assert.rejects(
            Promise.race([first.prompt("__disconnect__"), rejectAfter(200, "IPC disconnect was not observed")]),
            /IPC.*disconnect/u
        );
        await first.closed;

        const replacement = await factory.start({
            ...base,
            agentId: "ag-after-disconnect",
            localCwd: join(runtimeDirectory, "agents", "ag-after-disconnect", "cwd"),
            target: parseAgentWorkerTarget("worker-a:/repo/b")
        });
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
