import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentProviderRuntimePaths } from "../../src/builtin/provider/AgentProviderRuntimePaths.ts";
import { parseAgentWorkerTarget } from "../../src/builtin/worker/AgentWorkerTarget.ts";
import {
    OPENCODE_PROVIDER_VERSION,
    OpenCodeAgentProvider
} from "../../src/provider/opencode/OpenCodeAgentProvider.ts";
import {
    OPENCODE_PACKAGE_NAME,
    OPENCODE_RUNTIME_VERSION,
    OpenCodeProviderInstaller
} from "../../src/provider/opencode/OpenCodeProviderInstaller.ts";

const SYSTEM_OPENCODE = "/usr/bin/opencode";

test("OpenCode provider resolves only its bundled absolute command and never PATH opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-opencode-provider-"));
    try {
        const packageRoot = join(root, "provider", "node_modules", OPENCODE_PACKAGE_NAME);
        const command = join(packageRoot, "bin", "opencode.exe");
        await mkdir(join(packageRoot, "bin"), { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({
            bin: { opencode: "./bin/opencode.exe" },
            name: OPENCODE_PACKAGE_NAME,
            version: OPENCODE_RUNTIME_VERSION
        }), "utf8");
        await writeFile(command, "private opencode\n", "utf8");
        const installer = new OpenCodeProviderInstaller({
            resolver: async () => join(packageRoot, "package.json"),
            version: OPENCODE_RUNTIME_VERSION
        });
        const installation = await installer.ensureInstalled(new AgentProviderRuntimePaths({
            provider: "opencode",
            rootDirectory: root,
            version: OPENCODE_PROVIDER_VERSION
        }));

        assert.equal(installation.command, command);
        assert.equal(installation.command === SYSTEM_OPENCODE, false);
        assert.equal(installation.version, OPENCODE_RUNTIME_VERSION);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("OpenCode provider gives its runtime factory private state and the canonical Agent tool session", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-opencode-start-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            provider: "opencode",
            rootDirectory: root,
            version: OPENCODE_PROVIDER_VERSION
        });
        const target = parseAgentWorkerTarget("worker-a:/repo");
        const tools = {
            closed: new Promise<void>(() => undefined),
            modelTools: [{ description: "Run a shell command", inputSchema: { type: "object" }, name: "bash_run" }],
            target,
            tools: [{ description: "Run a shell command", inputSchema: { type: "object" }, name: "bash_run" }],
            async callTool() { return null; },
            async close() {}
        };
        let captured: Record<string, unknown> | undefined;
        const handle = { closed: new Promise<void>(() => undefined), async prompt() {}, async stop() {} };
        const provider = new OpenCodeAgentProvider({
            installer: { async ensureInstalled() { return { command: "/private/opencode", version: OPENCODE_RUNTIME_VERSION }; } },
            runtimeFactory: {
                async start(options) {
                    captured = options as unknown as Record<string, unknown>;
                    return handle;
                }
            }
        });
        const returned = await provider.start({
            agentId: "ag-opencode",
            processes: { async start() { throw new Error("unused"); } },
            runtime,
            target,
            tools
        });

        assert.equal(returned, handle);
        assert.equal(captured?.command, "/private/opencode");
        assert.equal(captured?.tools, tools);
        assert.equal(captured?.stateDirectory, runtime.stateDirectory);
        assert.match(String(captured?.localCwd), /agents\/ag-opencode\/cwd$/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
