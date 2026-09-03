import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PiAgentProcessFactory } from "../../src/provider/pi/PiAgentProcess.ts";

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
            target: { instance: "worker-a", workspace: "/repo/a" }
        });
        const second = await factory.start({
            ...base,
            agentId: "ag-two",
            localCwd: join(runtimeDirectory, "agents", "ag-two", "cwd"),
            target: { instance: "worker-a", workspace: "/repo/b" }
        });

        assert.equal(first.web?.upstream.toString(), "http://127.0.0.1:43199/");
        assert.equal(second.web?.upstream.toString(), first.web?.upstream.toString());
        await first.prompt("first");
        await second.steer?.("second");
        await first.stop();

        let entries = await readEntries(runtimeDirectory);
        assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
        assert.equal(entries.filter((entry) => entry.type === "init").length, 1);
        assert.equal(entries.filter((entry) => entry.type === "agent.start").length, 2);
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

async function readEntries(runtimeDirectory: string): Promise<Array<{
    agentDir: string;
    agentId: string;
    pid: string;
    type: string;
}>> {
    const text = await readFile(join(runtimeDirectory, "fake-pi-child.log"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => {
        const [pid, stateDir, type, agentId] = line.split("\t");
        return {
            agentDir: stateDir ?? "",
            agentId: agentId ?? "",
            pid: pid ?? "",
            type: type ?? ""
        };
    });
}
