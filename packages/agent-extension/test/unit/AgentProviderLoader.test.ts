import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@portable-devshell/extension";

import { AgentProviderLoader } from "../../src/AgentProviderLoader.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("agent-provider-loader");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const dataDirectory = join(root, "data");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    const context = {
        generation: "agent-generation-a",
        id: "agent",
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        paths: {
            codeDirectory: join(root, "code"),
            dataDirectory,
            runtimeDirectory: join(root, "runtime"),
            stateDirectory
        },
        version: "0.1.0",
        worker: { async openSession() { throw new Error("not used"); } }
    } satisfies ExtensionContext;
    return { context, dataDirectory, stateDirectory };
}

async function writeProvider(input: {
    dataDirectory: string;
    generation: string;
    id?: string;
    manifestApiVersion?: number;
    manifestVersion?: string;
    runtimeId?: string;
    runtimeVersion?: string;
}) {
    const id = input.id ?? "pi";
    const directory = join(input.dataDirectory, "providers", id, input.generation);
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "devshell-agent-provider.json"), `${JSON.stringify({
        apiVersion: input.manifestApiVersion ?? 1,
        entry: "dist/index.mjs",
        id,
        name: "Pi",
        schemaVersion: 1,
        version: input.manifestVersion ?? "0.1.0"
    })}\n`, "utf8");
    await writeFile(join(directory, "dist", "index.mjs"), [
        "export function createAgentProvider() {",
        `  return { id: ${JSON.stringify(input.runtimeId ?? id)}, version: ${JSON.stringify(input.runtimeVersion ?? "0.1.0")},`,
        "    async start() { throw new Error('not started in loader test'); }",
        "  };",
        "}",
        ""
    ].join("\n"), "utf8");
}

test("Agent provider selection is independent from the Agent Extension generation", async (t) => {
    const h = await harness(t);
    await writeProvider({ dataDirectory: h.dataDirectory, generation: "pi-hash-a" });
    await writeFile(join(h.stateDirectory, "providers.json"), `${JSON.stringify({
        providers: { pi: { enabled: true, generation: "pi-hash-a" } },
        schemaVersion: 1
    })}\n`, "utf8");

    const providers = await new AgentProviderLoader(h.context).loadSelected();

    assert.equal(h.context.generation, "agent-generation-a");
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.id, "pi");
    assert.equal(providers[0]?.version, "0.1.0");
});

test("Agent provider generation can change while the Agent Extension generation stays fixed", async (t) => {
    const h = await harness(t);
    await writeProvider({
        dataDirectory: h.dataDirectory,
        generation: "pi-hash-a",
        manifestVersion: "0.1.0",
        runtimeVersion: "0.1.0"
    });
    await writeProvider({
        dataDirectory: h.dataDirectory,
        generation: "pi-hash-b",
        manifestVersion: "0.1.1",
        runtimeVersion: "0.1.1"
    });
    const registryFile = join(h.stateDirectory, "providers.json");
    await writeFile(registryFile, `${JSON.stringify({
        providers: { pi: { enabled: true, generation: "pi-hash-a" } },
        schemaVersion: 1
    })}\n`, "utf8");
    const first = await new AgentProviderLoader(h.context).loadSelected();
    await writeFile(registryFile, `${JSON.stringify({
        providers: { pi: { enabled: true, generation: "pi-hash-b" } },
        schemaVersion: 1
    })}\n`, "utf8");
    const second = await new AgentProviderLoader(h.context).loadSelected();

    assert.equal(h.context.generation, "agent-generation-a");
    assert.equal(first[0]?.version, "0.1.0");
    assert.equal(second[0]?.version, "0.1.1");
});

test("Agent provider loader rejects incompatible or lying generations", async (t) => {
    const h = await harness(t);
    const registryFile = join(h.stateDirectory, "providers.json");
    await writeProvider({ dataDirectory: h.dataDirectory, generation: "bad-api", manifestApiVersion: 2 });
    await writeFile(registryFile, `${JSON.stringify({
        providers: { pi: { enabled: true, generation: "bad-api" } },
        schemaVersion: 1
    })}\n`, "utf8");
    await assert.rejects(
        () => new AgentProviderLoader(h.context).loadSelected(),
        /requires API version 2/u
    );

    await writeProvider({ dataDirectory: h.dataDirectory, generation: "lying", runtimeId: "other" });
    await writeFile(registryFile, `${JSON.stringify({
        providers: { pi: { enabled: true, generation: "lying" } },
        schemaVersion: 1
    })}\n`, "utf8");
    await assert.rejects(
        () => new AgentProviderLoader(h.context).loadSelected(),
        /returned id other/u
    );
});
