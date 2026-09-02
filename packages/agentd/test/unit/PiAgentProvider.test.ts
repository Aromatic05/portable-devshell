import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolDefinition } from "@portable-devshell/shared";

import type {
    AgentProviderStartContext,
    AgentWorkerClient
} from "../../src/provider/AgentProvider.ts";
import {
    PI_PROVIDER_VERSION,
    PiAgentProvider
} from "../../src/provider/pi/PiAgentProvider.ts";
import {
    PI_PACKAGE_NAME,
    PiProviderInstaller,
    type PiProviderInstallCommand
} from "../../src/provider/pi/PiProviderInstaller.ts";
import type {
    PiSdkModule,
    PiSessionLike
} from "../../src/provider/pi/PiSdkLoader.ts";
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
                const packageRoot = join(
                    command.cwd,
                    "node_modules",
                    "@earendil-works",
                    "pi-coding-agent"
                );
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

test("Pi provider creates one isolated session backed only by Worker custom tools", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "devshell-agentd-pi-session-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            homeDirectory,
            provider: "pi",
            version: PI_PROVIDER_VERSION
        });
        const target = parseAgentWorkerTarget("worker-a:/remote/project");
        const worker = createWorker([
            {
                description: "Run a command remotely.",
                group: "bash",
                inputSchema: { type: "object" },
                name: "bash_run",
                outputSchema: { type: "object" },
                requiredCapabilities: ["execute"]
            }
        ]);
        const context: AgentProviderStartContext = {
            agentId: "ag-pi-test",
            runtime,
            target,
            web: { basePath: "/agent/pi-test/" },
            worker
        };
        const prompts: Array<{ options?: { streamingBehavior?: "steer" | "followUp" }; text: string }> = [];
        let aborts = 0;
        let disposals = 0;
        const session: PiSessionLike = {
            async abort() {
                aborts += 1;
            },
            dispose() {
                disposals += 1;
            },
            async prompt(text, options) {
                prompts.push({ options, text });
            }
        };
        const sessionManagers: Array<{ cwd: string; sessionDir?: string }> = [];
        const sessionOptions: Array<Record<string, unknown>> = [];
        const loaderOptions: Array<Record<string, unknown>> = [];
        class FakeResourceLoader {
            constructor(options: Record<string, unknown> = {}) {
                loaderOptions.push(options);
            }
            async reload(): Promise<void> {}
        }
        const sdk: PiSdkModule = {
            DefaultResourceLoader: FakeResourceLoader,
            SessionManager: {
                create(cwd, sessionDir) {
                    sessionManagers.push({ cwd, sessionDir });
                    return { cwd, sessionDir };
                }
            },
            async createAgentSession(options = {}) {
                sessionOptions.push(options);
                return { session };
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
            loader: {
                async load(entrypoint) {
                    assert.equal(entrypoint, "/managed/pi/dist/index.js");
                    return sdk;
                }
            }
        });

        const handle = await provider.start(context);
        assert.equal(provider.id, "pi");
        assert.equal(provider.version, PI_PROVIDER_VERSION);
        assert.equal(sessionManagers.length, 1);
        assert.match(sessionManagers[0]!.cwd, /agents\/ag-pi-test\/cwd$/u);
        assert.match(sessionManagers[0]!.sessionDir!, /agents\/ag-pi-test\/sessions$/u);
        assert.equal(sessionOptions[0]?.noTools, "builtin");
        assert.deepEqual(sessionOptions[0]?.tools, ["bash_run"]);
        assert.equal(Array.isArray(sessionOptions[0]?.customTools), true);

        const systemPromptOverride = loaderOptions[0]?.systemPromptOverride as
            | ((basePrompt?: string) => string)
            | undefined;
        assert.equal(typeof systemPromptOverride, "function");
        const prompt = systemPromptOverride!("Pi base prompt");
        assert.match(prompt, /worker-a:\/remote\/project/u);
        assert.match(prompt, /local process cwd is only Pi runtime state/u);

        await handle.prompt("start");
        await handle.steer!("steer");
        await handle.followUp!("later");
        await handle.abort!();
        await handle.stop();

        assert.deepEqual(prompts, [
            { text: "start", options: undefined },
            { text: "steer", options: { streamingBehavior: "steer" } },
            { text: "later", options: { streamingBehavior: "followUp" } }
        ]);
        assert.equal(aborts, 2);
        assert.equal(disposals, 1);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

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
