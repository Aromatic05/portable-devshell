import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { PiChildMessage } from "../../src/provider/pi/PiProcessProtocol.ts";

function nextMessage(child: ChildProcess): Promise<PiChildMessage> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            child.off("message", onMessage);
            child.off("error", onError);
            child.off("exit", onExit);
        };
        const onMessage = (message: unknown) => {
            cleanup();
            resolve(message as PiChildMessage);
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            reject(new Error(`Pi provider child exited before replying (code=${String(code)}, signal=${String(signal)}).`));
        };
        child.once("message", onMessage);
        child.once("error", onError);
        child.once("exit", onExit);
    });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Pi provider child did not exit after parent IPC disconnect."));
        }, 5_000);
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

test("Pi provider child exits when its parent IPC channel disconnects", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "devshell-pi-child-disconnect-"));
    const childPath = fileURLToPath(new URL("../../src/provider/pi/PiAgentChild.ts", import.meta.url));
    const workspaceLoader = new URL("../RegisterWorkspacePackages.mjs", import.meta.url).href;
    const child = fork(childPath, [], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PI_CODING_AGENT_DIR: stateDirectory,
            TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH
        },
        execArgv: ["--import", "tsx", "--import", workspaceLoader],
        stdio: ["ignore", "ignore", "ignore", "ipc"]
    });

    try {
        const ready = nextMessage(child);
        child.send({
            entrypoint: fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
            type: "init",
            webBasePath: "/agent/"
        });
        const readyMessage = await ready;
        assert.equal(readyMessage.type, "ready");
        assert.equal(readyMessage.ok, true);
        assert.equal(typeof readyMessage.webUpstream, "string");
        child.disconnect();
        const exit = await waitForExit(child);
        assert.deepEqual(exit, { code: 0, signal: null });
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await rm(stateDirectory, { force: true, recursive: true });
    }
});
