import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createArtifactDirectoryArchive } from "../../../src/control/artifact/host/ArtifactHostArchive.ts";
import { ExtensionAssetCapabilityControl } from "../../../src/control/extension/ExtensionAssetCapabilityControl.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("extension-asset-capability");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const source = join(root, "source");
    const dataDirectory = join(root, "data");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "payload.txt"), "provider payload\n", "utf8");
    const bundle = join(root, "provider.dsprovider");
    await createArtifactDirectoryArchive(source, bundle);
    return { bundle, dataDirectory, root, source };
}

test("Extension assets install immutable content-addressed bundles from archives and directories", async (t) => {
    const h = await harness(t);
    const capability = new ExtensionAssetCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });

    const fromArchive = await capability.installBundle(h.bundle);
    const reused = await capability.installBundle(h.bundle);
    const fromDirectory = await capability.installDirectory(h.source);

    assert.match(fromArchive.generation, /^sha256-[0-9a-f]{64}$/u);
    assert.equal(reused.generation, fromArchive.generation);
    assert.equal(reused.directory, fromArchive.directory);
    assert.equal(await readFile(join(fromArchive.directory, "payload.txt"), "utf8"), "provider payload\n");
    assert.equal(await readFile(join(fromDirectory.directory, "payload.txt"), "utf8"), "provider payload\n");
    assert.deepEqual(await capability.resolveBundle(fromArchive.generation), fromArchive);
    assert.deepEqual(
        (await capability.listBundles()).map((bundle) => bundle.generation).sort(),
        [...new Set([fromArchive.generation, fromDirectory.generation])].sort()
    );
});

test("Extension assets refuse undeclared access and symlink sources", async (t) => {
    const h = await harness(t);
    const denied = new ExtensionAssetCapabilityControl({
        allowed: false,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });
    await assert.rejects(denied.installBundle(h.bundle), /did not declare the assets capability/u);
    await assert.rejects(denied.installDirectory(h.source), /did not declare the assets capability/u);

    const link = join(h.root, "provider-link.dsprovider");
    await symlink(h.bundle, link);
    const allowed = new ExtensionAssetCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });
    await assert.rejects(allowed.installBundle(link), /regular file, not a symlink/u);
});

test("Extension assets remove and resolve only validated bundle generations", async (t) => {
    const h = await harness(t);
    const capability = new ExtensionAssetCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });
    const installed = await capability.installBundle(h.bundle);

    await capability.removeBundle(installed.generation);
    await assert.rejects(access(installed.directory));
    assert.equal(await capability.resolveBundle(installed.generation), undefined);
    await assert.rejects(capability.removeBundle("../escape"), /Invalid Extension asset bundle generation/u);
});

test("Extension assets transfer only installed bundles through the injected Artifact port", async (t) => {
    const h = await harness(t);
    const calls: unknown[] = [];
    const capability = new ExtensionAssetCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "skill",
        transfer: async (input) => {
            calls.push(input);
            return { transferId: "transfer-1", transferredBytes: 17 };
        }
    });
    const installed = await capability.installDirectory(h.source);
    const signal = new AbortController().signal;

    assert.deepEqual(await capability.transferBundle({
        generation: installed.generation,
        overwrite: true,
        signal,
        target: {
            instance: "remote-one",
            path: "./.devshell/skill/review",
            workspace: "/home/dev"
        }
    }), { transferId: "transfer-1", transferredBytes: 17 });
    assert.deepEqual(calls, [{
        overwrite: true,
        signal,
        sourcePath: installed.directory,
        target: {
            instance: "remote-one",
            path: "./.devshell/skill/review",
            workspace: "/home/dev"
        }
    }]);
    await assert.rejects(
        capability.transferBundle({
            generation: "sha256-" + "0".repeat(64),
            target: { instance: "remote-one", path: "./x", workspace: "/home/dev" }
        }),
        /is not installed/u
    );
});
