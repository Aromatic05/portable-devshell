import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type {
    AgentProviderHandle,
    AgentProviderStartContext
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
    PiProviderInstaller
} from "../../src/provider/pi/PiProviderInstaller.ts";
import { AgentProviderRuntimePaths } from "../../src/runtime/AgentProviderRuntimePaths.ts";
import { parseAgentWorkerTarget } from "../../src/target/AgentWorkerTarget.ts";

test("Pi runtime resolves from portable-devshell's bundled dependency without host npm", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "devshell-agentd-pi-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            homeDirectory,
            provider: "pi",
            version: PI_PROVIDER_VERSION
        });
        const packageRoot = join(homeDirectory, "application", "node_modules", "@earendil-works", "pi-coding-agent");
        const entrypoint = join(packageRoot, "dist", "index.js");
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await writeFile(
            join(packageRoot, "package.json"),
            JSON.stringify({ name: PI_PACKAGE_NAME, version: PI_PROVIDER_VERSION }),
            "utf8"
        );
        await writeFile(entrypoint, "export {};\n", "utf8");
        let resolves = 0;
        const installer = new PiProviderInstaller({
            resolver: async () => {
                resolves += 1;
                return pathToFileURL(entrypoint).href;
            },
            version: PI_PROVIDER_VERSION
        });

        const first = await installer.ensureInstalled(runtime);
        const second = await installer.ensureInstalled(runtime);

        assert.equal(first.entrypoint, second.entrypoint);
        assert.equal(first.entrypoint, entrypoint);
        assert.equal(first.packageRoot, packageRoot);
        assert.equal(first.version, PI_PROVIDER_VERSION);
        assert.equal(resolves, 1);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("Pi provider maps each Agent into the shared managed Pi state/runtime", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "devshell-agentd-pi-session-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            homeDirectory,
            provider: "pi",
            version: PI_PROVIDER_VERSION
        });
        const target = parseAgentWorkerTarget("worker-a:/remote/project");
        const context: AgentProviderStartContext = {
            agentId: "ag-pi-test",
            runtime,
            target,
            web: { basePath: "/agent/" }
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
        assert.equal(starts[0]?.agentDir, runtime.stateDirectory);
        assert.equal(starts[0]?.agentId, "ag-pi-test");
        assert.equal(starts[0]?.entrypoint, "/managed/pi/dist/index.js");
        assert.deepEqual(starts[0]?.target, target);
        assert.match(starts[0]!.localCwd, /agents\/ag-pi-test\/cwd$/u);
        assert.equal(starts[0]?.webBasePath, "/agent/");
        assert.equal("tools" in starts[0]!, false);
        assert.equal("callTool" in starts[0]!, false);
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
