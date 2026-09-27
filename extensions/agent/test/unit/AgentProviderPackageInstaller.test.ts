import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type {
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionProcessStartInput,
} from "@portable-devshell/extension";

import {
    AgentProviderPackageInstaller,
    type AgentProviderPackageSpec,
} from "../../src/builtin/provider/AgentProviderPackageInstaller.ts";
import { AgentProviderRuntimePaths } from "../../src/builtin/provider/AgentProviderRuntimePaths.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const spec: AgentProviderPackageSpec = {
    dependencies: {
        "@example/runtime": "1.2.3",
        helper: "4.5.6",
    },
    id: "test",
    version: "0.3.0",
};

test("Provider runtime dependencies install on the client and are reused until update", async (t) => {
    const h = await harness(t);

    await h.installer.install(h.runtime, spec);
    assert.equal(await h.installer.isInstalled(h.runtime, spec), true);
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0]?.command, process.platform === "win32" ? "npm.cmd" : "npm");
    assert.deepEqual(h.starts[0]?.args, [
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
    ]);

    await h.installer.install(h.runtime, spec);
    assert.equal(h.starts.length, 1);

    await h.installer.install(h.runtime, spec, { force: true });
    assert.equal(h.starts.length, 2);
    assert.equal(await h.installer.isInstalled(h.runtime, spec), true);

    await h.installer.remove(h.runtime);
    assert.equal(await h.installer.isInstalled(h.runtime, spec), false);
});

test("failed Provider dependency install does not publish a partial runtime", async (t) => {
    const h = await harness(t, { failNext: true });

    await assert.rejects(
        h.installer.install(h.runtime, spec),
        /Failed to install Agent provider test dependencies/u,
    );
    assert.equal(await h.installer.isInstalled(h.runtime, spec), false);
});

async function harness(
    t: test.TestContext,
    options: { failNext?: boolean } = {},
) {
    const root = await createTestTempDirectory("agent-provider-package");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const starts: ExtensionProcessStartInput[] = [];
    let failNext = options.failNext ?? false;
    const processes: ExtensionProcessCapability = {
        async start(input) {
            starts.push(input);
            if (!failNext) {
                await materializeDeclaredPackages(input.cwd!);
            }
            const code = failNext ? 1 : 0;
            failNext = false;
            return fakeProcess(code);
        },
    };
    const installer = new AgentProviderPackageInstaller(processes);
    const runtime = new AgentProviderRuntimePaths({
        provider: spec.id,
        rootDirectory: root,
        version: spec.version,
    });
    return { installer, runtime, starts };
}

async function materializeDeclaredPackages(root: string): Promise<void> {
    const manifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(manifest.dependencies)) {
        const directory = join(root, "node_modules", ...name.split("/"));
        await mkdir(directory, { recursive: true });
        await writeFile(
            join(directory, "package.json"),
            JSON.stringify({ name, version }),
            "utf8",
        );
    }
}

function fakeProcess(code: number): ExtensionManagedProcess {
    return {
        closed: Promise.resolve({ code }),
        onMessage() {
            return () => undefined;
        },
        onStderr(listener) {
            if (code !== 0) listener("npm failed");
            return () => undefined;
        },
        onStdout() {
            return () => undefined;
        },
        async send() {},
        async terminate() {},
    };
}
