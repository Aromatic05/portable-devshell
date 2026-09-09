import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createArtifactDirectoryArchive } from "../../../src/control/artifact/host/ArtifactHostArchive.ts";
import { ExtensionAssetCapabilityControl } from "../../../src/control/extension/host/generation/capability/ExtensionAssetCapabilityControl.ts";
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

    const archiveDigest = createHash("sha256").update(await readFile(h.bundle)).digest("hex");
    assert.equal(fromArchive.generation, `sha256-${archiveDigest}`);
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

test("Extension assets project installed bundles into a named Worker resource collection", async (t) => {
    const h = await harness(t);
    const calls: unknown[] = [];
    const capability = new ExtensionAssetCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "skill",
        project: async (input) => {
            calls.push(input);
            return { transferId: "transfer-resource", transferredBytes: 23 };
        }
    });
    const installed = await capability.installDirectory(h.source);
    const signal = new AbortController().signal;

    assert.deepEqual(await capability.projectBundle({
        generation: installed.generation,
        overwrite: true,
        signal,
        target: {
            collection: "managed",
            instance: "remote-one",
            key: "Review changes"
        }
    }), { transferId: "transfer-resource", transferredBytes: 23 });
    assert.deepEqual(calls, [{
        overwrite: true,
        signal,
        sourcePath: installed.directory,
        target: {
            collection: "managed",
            instance: "remote-one",
            key: "Review changes"
        }
    }]);

    await assert.rejects(
        capability.projectBundle({
            generation: installed.generation,
            target: { collection: "managed", instance: "remote-one", key: "../escape" }
        }),
        /resource key/u
    );
});
