import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { AgentProviderHandle, AgentProviderStartContext } from "../../src/builtin/provider/AgentProvider.ts";
import { AgentProviderRuntimePaths } from "../../src/builtin/provider/AgentProviderRuntimePaths.ts";
import { parseAgentWorkerTarget } from "../../src/builtin/worker/AgentWorkerTarget.ts";
import {
    PI_PROVIDER_VERSION,
    PiAgentProvider
} from "../../src/provider/pi/PiAgentProvider.ts";
import type {
    PiAgentProcessStartOptions,
    PiAgentRuntimeFactory
} from "../../src/provider/pi/PiAgentProcess.ts";
import {
    PI_BOOTSTRAP_VERSION,
    PI_PACKAGE_NAME,
    PiProviderInstaller
} from "../../src/provider/pi/PiProviderInstaller.ts";

test("Pi provider implementation version is independent from the Pi bootstrap version", () => {
    assert.equal(PI_PROVIDER_VERSION, "0.1.2");
    assert.notEqual(PI_PROVIDER_VERSION, PI_BOOTSTRAP_VERSION);
});

test("Pi bootstrap version matches the bundled package dependency", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
        dependencies?: Record<string, string>;
    };
    assert.equal(manifest.dependencies?.[PI_PACKAGE_NAME], PI_BOOTSTRAP_VERSION);
});

test("Pi provider bootstraps a stable managed install once and preserves later Pi updates", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "devshell-agentd-pi-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            provider: "pi",
            rootDirectory,
            version: PI_PROVIDER_VERSION
        });
        const seedRoot = join(rootDirectory, "provider-seed");
        const packageRoot = join(seedRoot, "node_modules", "@earendil-works", "pi-coding-agent");
        const entrypoint = join(packageRoot, "dist", "index.js");
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await writeFile(
            join(packageRoot, "package.json"),
            JSON.stringify({ name: PI_PACKAGE_NAME, version: PI_BOOTSTRAP_VERSION }),
            "utf8"
        );
        await writeFile(entrypoint, "export {};\n", "utf8");
        let resolves = 0;
        const installer = new PiProviderInstaller({
            resolver: async () => {
                resolves += 1;
                return pathToFileURL(entrypoint).href;
            },
            version: PI_BOOTSTRAP_VERSION
        });

        const first = await installer.ensureInstalled(runtime);
        assert.equal(first.version, PI_BOOTSTRAP_VERSION);
        assert.match(first.entrypoint, /providers\/pi\/install\/releases\/0\.85\.1\/node_modules/u);
        assert.notEqual(first.entrypoint, entrypoint);

        const upgradedVersion = "0.99.0";
        const upgradedRoot = join(runtime.installationDirectory, "releases", upgradedVersion);
        const upgradedPackageRoot = join(upgradedRoot, "node_modules", "@earendil-works", "pi-coding-agent");
        const upgradedEntrypoint = join(upgradedPackageRoot, "dist", "index.js");
        await mkdir(join(upgradedPackageRoot, "dist"), { recursive: true });
        await writeFile(join(upgradedPackageRoot, "package.json"), JSON.stringify({ name: PI_PACKAGE_NAME, version: upgradedVersion }), "utf8");
        await writeFile(upgradedEntrypoint, "export {};\n", "utf8");
        await writeFile(join(runtime.installationDirectory, "current-version"), `${upgradedVersion}\n`, "utf8");

        const afterProviderUpgrade = await new PiProviderInstaller({
            resolver: async () => entrypoint,
            version: PI_BOOTSTRAP_VERSION
        }).ensureInstalled(new AgentProviderRuntimePaths({
            provider: "pi",
            rootDirectory,
            version: "9.9.9"
        }));

        assert.equal(afterProviderUpgrade.version, upgradedVersion);
        assert.equal(afterProviderUpgrade.entrypoint, upgradedEntrypoint);
        assert.equal(resolves, 1);
    } finally {
        await rm(rootDirectory, { force: true, recursive: true });
    }
});

test("Pi provider maps each Agent into the shared managed runtime with its injected tool session", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "devshell-agentd-pi-session-"));
    try {
        const runtime = new AgentProviderRuntimePaths({
            provider: "pi",
            rootDirectory,
            version: PI_PROVIDER_VERSION
        });
        const target = parseAgentWorkerTarget("worker-a:/remote/project");
        const context: AgentProviderStartContext = {
            agentId: "ag-pi-test",
            processes: {
                async start() { throw new Error("unused test process capability"); }
            },
            runtime,
            target,
            tools: toolSession(target),
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
                        agentDirectory: "/managed/state/pi",
                        entrypoint: "/managed/pi/dist/index.js",
                        managedInstallRoot: "/managed/pi",
                        packageRoot: "/managed/pi",
                        version: PI_BOOTSTRAP_VERSION
                    };
                }
            },
            runtimeFactory
        });

        const returned = await provider.start(context);

        assert.equal(returned, handle);
        assert.equal(starts.length, 1);
        assert.equal(starts[0]?.runtimeDirectory, runtime.stateDirectory);
        assert.equal(starts[0]?.agentDirectory, "/managed/state/pi");
        assert.equal(starts[0]?.agentId, "ag-pi-test");
        assert.equal(starts[0]?.entrypoint, "/managed/pi/dist/index.js");
        assert.equal(starts[0]?.managedInstallRoot, "/managed/pi");
        assert.deepEqual(starts[0]?.target, target);
        assert.equal(starts[0]?.tools, context.tools);
        assert.match(starts[0]!.localCwd, /agents\/ag-pi-test\/cwd$/u);
        assert.equal(starts[0]?.webBasePath, "/agent/");
    } finally {
        await rm(rootDirectory, { force: true, recursive: true });
    }
});

function createProviderHandle(): AgentProviderHandle {
    return {
        closed: new Promise<void>(() => undefined),
        async abort() {},
        async followUp() {},
        async prompt() {},
        async steer() {},
        async stop() {}
    };
}

function toolSession(target: ReturnType<typeof parseAgentWorkerTarget>) {
    return {
        closed: new Promise<void>(() => undefined),
        modelTools: [],
        target,
        tools: [],
        async callTool() { return null; },
        async close() {}
    };
}
