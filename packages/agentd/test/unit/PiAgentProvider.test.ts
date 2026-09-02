import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolDefinition } from "@portable-devshell/shared";

import type {
    AgentProviderHandle,
    AgentProviderStartContext,
    AgentWorkerClient
} from "../../src/provider/AgentProvider.ts";
import {
    PI_PROVIDER_VERSION,
    PiAgentProvider
} from "../../src/provider/pi/PiAgentProvider.ts";
import type {
    PiAgentProcessStartOptions,
    PiAgentRuntimeFactory
} from "../../src/provider/pi/PiAgentProcess.ts";
import {
    PI_PACKAGE_NAME,
    PiProviderInstaller,
    type PiProviderInstallCommand
} from "../../src/provider/pi/PiProviderInstaller.ts";
import { createPiWorkerTools } from "../../src/provider/pi/PiWorkerTools.ts";
import { AgentProviderRuntimePaths } from "../../src/runtime/AgentProviderRuntimePaths.ts";
import { parseAgentWorkerTarget } from "../../src/target/AgentWorkerTarget.ts";

test("Pi installer owns a private versioned prefix and reuses a valid install", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "devshell-agentd-pi-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            homeDirectory,
            provider: "pi",
            version: PI_PROVIDER_VERSION
        });
        const commands: PiProviderInstallCommand[] = [];
        const installer = new PiProviderInstaller({
            runner: async (command) => {
                commands.push(command);
                const packageRoot = join(command.cwd, "node_modules", "@earendil-works", "pi-coding-agent");
                await mkdir(join(packageRoot, "dist"), { recursive: true });
                await writeFile(
                    join(packageRoot, "package.json"),
                    JSON.stringify({ name: PI_PACKAGE_NAME, version: PI_PROVIDER_VERSION }),
                    "utf8"
                );
                await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
            },
            version: PI_PROVIDER_VERSION
        });

        const first = await installer.ensureInstalled(runtime);
        const second = await installer.ensureInstalled(runtime);

        assert.equal(first.entrypoint, second.entrypoint);
        assert.equal(commands.length, 1);
        assert.equal(commands[0]?.cwd, runtime.prefixDirectory);
        assert.equal(commands[0]?.args.includes("--ignore-scripts"), true);
        assert.equal(commands[0]?.args.at(-1), `${PI_PACKAGE_NAME}@${PI_PROVIDER_VERSION}`);
        assert.equal(
            JSON.parse(await readFile(join(runtime.prefixDirectory, "package.json"), "utf8")).private,
            true
        );
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("Pi Worker tools preserve Worker schema and Pi tool-call identity", async () => {
    const calls: Array<{ operationId: string; toolName: string }> = [];
    const definition: ToolDefinition = {
        description: "Read a file from the remote workspace.",
        group: "file",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        },
        name: "file_read",
        outputSchema: { type: "object" },
        requiredCapabilities: ["read"]
    };
    const worker = createWorker([definition], async (toolName, _input, options) => {
        calls.push({ operationId: options.operationId, toolName });
        return { content: "hello" };
    });

    const [tool] = await createPiWorkerTools(worker);
    const result = await tool!.execute("pi-tool-42", { path: "README.md" });

    assert.equal(tool?.name, "file_read");
    assert.deepEqual(tool?.parameters, definition.inputSchema);
    assert.deepEqual(calls, [{ operationId: "pi-tool-42", toolName: "file_read" }]);
    assert.deepEqual(result.details, { content: "hello" });
    assert.match(result.content[0]!.text, /hello/u);
});

test("Pi provider launches one isolated runtime process per Agent and passes only Worker tool capability", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "devshell-agentd-pi-session-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            homeDirectory,
            provider: "pi",
            version: PI_PROVIDER_VERSION
        });
        const target = parseAgentWorkerTarget("worker-a:/remote/project");
        const definition: ToolDefinition = {
            description: "Run a command remotely.",
            group: "bash",
            inputSchema: { type: "object" },
            name: "bash_run",
            outputSchema: { type: "object" },
            requiredCapabilities: ["execute"]
        };
        const worker = createWorker([definition]);
        const context: AgentProviderStartContext = {
            agentId: "ag-pi-test",
            runtime,
            target,
            web: { basePath: "/agent/pi-test/" },
            worker
        };
        const starts: PiAgentProcessStartOptions[] = [];
        const handle = createProviderHandle();
        const runtimeFactory: PiAgentRuntimeFactory = {
            async start(options) {
                starts.push(options);
                return handle;
            }
        };
        const provider = new PiAgentProvider({
            installer: {
                async ensureInstalled() {
                    return {
                        entrypoint: "/managed/pi/dist/index.js",
                        packageRoot: "/managed/pi",
                        version: PI_PROVIDER_VERSION
                    };
                }
            },
            runtimeFactory
        });

        const returned = await provider.start(context);

        assert.equal(returned, handle);
        assert.equal(starts.length, 1);
        assert.equal(starts[0]?.entrypoint, "/managed/pi/dist/index.js");
        assert.equal(starts[0]?.remoteWorkspace, "worker-a:/remote/project");
        assert.match(starts[0]!.localCwd, /agents\/ag-pi-test\/cwd$/u);
        assert.match(starts[0]!.sessionDir, /agents\/ag-pi-test\/sessions$/u);
        assert.deepEqual(starts[0]?.tools, [definition]);

        await starts[0]!.callTool("bash_run", { command: "true" }, { operationId: "pi-call" });
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

function createProviderHandle(): AgentProviderHandle {
    return {
        async abort() {},
        async followUp() {},
        async prompt() {},
        async steer() {},
        async stop() {}
    };
}

function createWorker(
    tools: readonly ToolDefinition[],
    invoke: AgentWorkerClient["callTool"] = async () => ({ ok: true })
): AgentWorkerClient {
    return {
        target: parseAgentWorkerTarget("worker-a:/remote/project"),
        callTool: invoke,
        async close() {},
        async listTools() {
            return tools;
        }
    };
}
