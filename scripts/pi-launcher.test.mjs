import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { resolveManagedPiRuntime } from "./pi-launcher.mjs";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

test("pi launcher reports an actionable error when the provider is not installed", async () => {
    const root = await createTestTempDirectory("pi-launcher-missing-provider");
    try {
        await assert.rejects(
            () => resolveManagedPiRuntime({ XDG_DATA_HOME: resolve(root, "data") }, resolve(root, "home")),
            /devshell agent provider install/u
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("pi launcher resolves the selected provider generation without embedding a Pi version", async () => {
    const root = await createTestTempDirectory("pi-launcher-provider");
    const home = resolve(root, "home");
    const data = resolve(root, "data");
    const generation = "sha256-test-generation";
    const provider = resolve(data, "portable-devshell", "extension-data", "agent", "bundles", generation);
    const piRoot = resolve(provider, "node_modules", "@earendil-works", "pi-coding-agent");
    const extensionEntrypoint = resolve(provider, "dist", "provider", "pi", "extension", "index.js");
    const registryDirectory = resolve(home, ".devshell", "control", "extensions", "state", "agent");
    try {
        await mkdir(resolve(piRoot, "dist"), { recursive: true });
        await mkdir(resolve(provider, "dist", "provider", "pi", "extension"), { recursive: true });
        await mkdir(registryDirectory, { recursive: true });
        await writeFile(resolve(piRoot, "package.json"), JSON.stringify({ bin: { pi: "./dist/cli.js" } }), "utf8");
        await writeFile(resolve(piRoot, "dist", "cli.js"), "export {};\n", "utf8");
        await writeFile(extensionEntrypoint, "export default () => {};\n", "utf8");
        await writeFile(resolve(registryDirectory, "providers.json"), `${JSON.stringify({
            providers: {
                pi: {
                    enabled: true,
                    lastKnownGoodGeneration: generation,
                    selectedGeneration: generation
                }
            },
            schemaVersion: 1
        })}\n`, "utf8");

        const runtime = await resolveManagedPiRuntime({ XDG_DATA_HOME: data }, home);
        assert.equal(runtime.selectedGeneration, generation);
        assert.equal(runtime.providerDirectory, provider);
        assert.equal(runtime.piEntrypoint, resolve(piRoot, "dist", "cli.js"));
        assert.equal(runtime.extensionEntrypoint, extensionEntrypoint);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
