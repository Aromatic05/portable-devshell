import assert from "node:assert/strict";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { launchInstalledPi } from "../../src/builtin/pi/PiLauncher.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

async function createLauncherHarness() {
    const root = await createTestTempDirectory("agent-pi-launcher");
    const home = join(root, "home");
    const dataHome = join(root, "data");
    const devshellHome = join(home, ".devshell");
    const agentStateDirectory = join(
        devshellHome,
        "control",
        "extensions",
        "state",
        "agent",
    );
    const providerDirectory = join(
        agentStateDirectory,
        "providers",
        "pi",
    );
    const managedInstallRoot = join(providerDirectory, "install");
    const releaseRoot = join(managedInstallRoot, "releases", "0.99.1");
    const packageRoot = join(
        releaseRoot,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
    );
    const coreRoot = join(dataHome, "portable-devshell", "current");
    const capturePath = join(root, "capture.json");
    const projectDirectory = join(root, "project");

    await Promise.all([
        mkdir(agentStateDirectory, { recursive: true }),
        mkdir(join(packageRoot, "dist"), { recursive: true }),
        mkdir(coreRoot, { recursive: true }),
        mkdir(projectDirectory, { recursive: true }),
    ]);
    await writeFile(
        join(agentStateDirectory, "providers.json"),
        JSON.stringify({
            providers: {
                pi: {
                    enabled: true,
                    installedVersion: "0.1.3",
                },
            },
            schemaVersion: 2,
        }),
        "utf8",
    );
    await writeFile(
        join(managedInstallRoot, "managed-install.json"),
        JSON.stringify({
            kind: "pi-managed-install",
            layout: "releases-v1",
            schemaVersion: 1,
        }),
        "utf8",
    );
    await writeFile(
        join(managedInstallRoot, "current-version"),
        "0.99.1\n",
        "utf8",
    );
    await writeFile(
        join(releaseRoot, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
        "utf8",
    );
    await writeFile(
        join(coreRoot, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
        "utf8",
    );
    await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
            bin: { pi: "cli.mjs" },
            main: "dist/index.js",
            name: "@earendil-works/pi-coding-agent",
            type: "module",
            version: "0.99.1",
        }),
        "utf8",
    );
    await writeFile(
        join(packageRoot, "dist", "index.js"),
        "export {};\n",
        "utf8",
    );
    await writeFile(
        join(packageRoot, "cli.mjs"),
        [
            'import { writeFile } from "node:fs/promises";',
            "await writeFile(process.env.PI_LAUNCHER_CAPTURE, JSON.stringify({",
            "  cwd: process.cwd(),",
            '  hasAgentDir: Object.hasOwn(process.env, "PI_CODING_AGENT_DIR"),',
            "  agentDir: process.env.PI_CODING_AGENT_DIR ?? null,",
            "  workspace: process.env.PORTABLE_DEVSHELL_PI_WORKSPACE ?? null",
            '}), "utf8");',
            "",
        ].join("\n"),
        "utf8",
    );

    return { capturePath, dataHome, devshellHome, home, projectDirectory };
}

async function withPiLaunchEnvironment<T>(
    input: {
        capturePath: string;
        dataHome: string;
        devshellHome: string;
        home: string;
        projectDirectory: string;
    },
    agentDirectory: string | undefined,
    run: () => Promise<T>,
): Promise<T> {
    const originalCwd = process.cwd();
    const originalArgv = process.argv;
    const keys = [
        "PI_CODING_AGENT_DIR",
        "PI_LAUNCHER_CAPTURE",
        "PORTABLE_DEVSHELL_HOME",
        "PORTABLE_DEVSHELL_PI_WORKSPACE",
        "XDG_DATA_HOME",
    ] as const;
    const previous = Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
    );
    try {
        process.chdir(input.projectDirectory);
        process.env.PI_LAUNCHER_CAPTURE = input.capturePath;
        process.env.PORTABLE_DEVSHELL_HOME = input.devshellHome;
        process.env.XDG_DATA_HOME = input.dataHome;
        delete process.env.PORTABLE_DEVSHELL_PI_WORKSPACE;
        if (agentDirectory === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = agentDirectory;
        return await run();
    } finally {
        process.chdir(originalCwd);
        process.argv = originalArgv;
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test("direct Pi keeps the invoking cwd and leaves Pi's default user data directory unresolved", async () => {
    const h = await createLauncherHarness();
    await withPiLaunchEnvironment(h, undefined, async () => {
        await launchInstalledPi([], process.env, h.home);
        const capture = JSON.parse(await readFile(h.capturePath, "utf8"));
        assert.equal(capture.cwd, h.projectDirectory);
        assert.equal(capture.hasAgentDir, false);
        assert.equal(capture.agentDir, null);
        assert.equal(capture.workspace, h.projectDirectory);
        await assert.rejects(
            () => lstat(join(h.devshellHome, "pi", "workspaces")),
            /ENOENT/u,
        );
    });
    assert.notEqual(process.cwd(), h.projectDirectory);
});

test("direct Pi preserves an explicit PI_CODING_AGENT_DIR", async () => {
    const h = await createLauncherHarness();
    const nativeAgentDirectory = join(h.home, ".pi", "agent-custom");
    await withPiLaunchEnvironment(h, nativeAgentDirectory, async () => {
        await launchInstalledPi([], process.env, h.home);
        const capture = JSON.parse(await readFile(h.capturePath, "utf8"));
        assert.equal(capture.cwd, h.projectDirectory);
        assert.equal(capture.hasAgentDir, true);
        assert.equal(capture.agentDir, nativeAgentDirectory);
        await assert.rejects(
            () => lstat(join(h.devshellHome, "pi", "workspaces")),
            /ENOENT/u,
        );
    });
    assert.notEqual(process.cwd(), h.projectDirectory);
});
