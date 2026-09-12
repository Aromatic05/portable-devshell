import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AgentProviderRuntimePaths } from "../../src/builtin/provider/AgentProviderRuntimePaths.ts";
import { OPENCODE_PROVIDER_VERSION } from "../../src/provider/opencode/OpenCodeAgentProvider.ts";
import {
    OPENCODE_RUNTIME_VERSION,
    OpenCodeProviderInstaller
} from "../../src/provider/opencode/OpenCodeProviderInstaller.ts";
import type { OpenCodeChildMessage } from "../../src/provider/opencode/OpenCodeProcessProtocol.ts";

test("OpenCode provider child completes ACP lifecycle using only the private bundled runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-opencode-child-"));
    const runtimePaths = new AgentProviderRuntimePaths({
        provider: "opencode",
        rootDirectory: root,
        version: OPENCODE_PROVIDER_VERSION
    });
    const installation = await new OpenCodeProviderInstaller({ version: OPENCODE_RUNTIME_VERSION })
        .ensureInstalled(runtimePaths);
    assert.notEqual(installation.command, process.platform === "win32" ? "C:\\Windows\\opencode.exe" : "/usr/bin/opencode");

    const childPath = fileURLToPath(new URL("../../src/provider/opencode/OpenCodeAgentChild.ts", import.meta.url));
    const workspaceLoader = new URL("../RegisterWorkspacePackages.mjs", import.meta.url).href;
    const child = fork(childPath, ["10000"], {
        cwd: process.cwd(),
        env: { ...process.env, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH },
        execArgv: ["--import", "tsx", "--import", workspaceLoader],
        stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    try {
        child.send({
            command: installation.command,
            id: "init-real",
            localCwd: join(root, "cwd"),
            modelTools: [],
            stateDirectory: runtimePaths.stateDirectory,
            type: "init"
        });
        const ready = await nextMessage(child, (message) => message.type === "ready" && message.id === "init-real");
        assert.deepEqual(ready, { id: "init-real", ok: true, type: "ready" }, stderr);

        child.send({ command: "wait", id: "wait-real", type: "command" });
        const idle = await nextMessage(child, (message) => message.type === "result" && message.id === "wait-real");
        assert.deepEqual(idle, { id: "wait-real", ok: true, type: "result" }, stderr);

        child.send({ command: "stop", id: "stop-real", type: "command" });
        const stopped = await nextMessage(child, (message) => message.type === "result" && message.id === "stop-real");
        assert.deepEqual(stopped, { id: "stop-real", ok: true, type: "result" }, stderr);
        child.disconnect();
        await waitForExit(child);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
});

test("OpenCode provider child accepts a new prompt after the previous ACP turn becomes idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-opencode-child-turns-"));
    const command = await writeFakeAcpAgent(root);
    const childPath = fileURLToPath(new URL("../../src/provider/opencode/OpenCodeAgentChild.ts", import.meta.url));
    const workspaceLoader = new URL("../RegisterWorkspacePackages.mjs", import.meta.url).href;
    const child = fork(childPath, ["10000"], {
        cwd: process.cwd(),
        env: { ...process.env, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH },
        execArgv: ["--import", "tsx", "--import", workspaceLoader],
        stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    try {
        child.send({
            command,
            id: "init-turns",
            localCwd: join(root, "cwd"),
            modelTools: [],
            stateDirectory: join(root, "state"),
            type: "init"
        });
        const ready = await nextMessage(child, (message) => message.type === "ready" && message.id === "init-turns");
        assert.deepEqual(ready, { id: "init-turns", ok: true, type: "ready" }, stderr);

        for (const turn of ["first", "second"]) {
            child.send({ command: "prompt", id: `prompt-${turn}`, message: turn, type: "command" });
            const prompted = await nextMessage(
                child,
                (message) => message.type === "result" && message.id === `prompt-${turn}`
            );
            assert.deepEqual(prompted, { id: `prompt-${turn}`, ok: true, type: "result" }, stderr);

            child.send({ command: "wait", id: `wait-${turn}`, type: "command" });
            const idle = await nextMessage(child, (message) => message.type === "result" && message.id === `wait-${turn}`);
            assert.deepEqual(idle, { id: `wait-${turn}`, ok: true, type: "result" }, stderr);
        }

        assert.deepEqual((await readFile(join(root, "prompts.log"), "utf8")).trim().split("\n"), ["first", "second"]);
        child.send({ command: "stop", id: "stop-turns", type: "command" });
        await nextMessage(child, (message) => message.type === "result" && message.id === "stop-turns");
        child.disconnect();
        await waitForExit(child);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
});

async function writeFakeAcpAgent(root: string): Promise<string> {
    const command = join(root, "fake-opencode-acp.mjs");
    const sdk = import.meta.resolve("@agentclientprotocol/sdk");
    const logPath = join(root, "prompts.log");
    await writeFile(command, `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(sdk)};

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
acp.agent({ name: "fake-opencode" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => ({
        agentCapabilities: { loadSession: false },
        authMethods: [],
        protocolVersion: params.protocolVersion
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "fake-session" }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
        const text = params.prompt?.find((block) => block.type === "text")?.text ?? "";
        await appendFile(${JSON.stringify(logPath)}, text + "\\n", "utf8");
        return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {})
    .connect(stream);
`, "utf8");
    await chmod(command, 0o755);
    return command;
}

function nextMessage(
    child: ChildProcess,
    predicate: (message: OpenCodeChildMessage) => boolean
): Promise<OpenCodeChildMessage> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for OpenCode provider child message."));
        }, 30_000);
        const cleanup = () => {
            clearTimeout(timeout);
            child.off("message", onMessage);
            child.off("exit", onExit);
        };
        const onMessage = (value: unknown) => {
            const message = value as OpenCodeChildMessage;
            if (!predicate(message)) return;
            cleanup();
            resolve(message);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            reject(new Error(`OpenCode provider child exited early (${String(code)}/${String(signal)}).`));
        };
        child.on("message", onMessage);
        child.once("exit", onExit);
    });
}

function waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("OpenCode provider child did not exit after IPC disconnect."));
        }, 5_000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
}
