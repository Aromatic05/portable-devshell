import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createArtifactDirectoryArchive } from "../../../src/control/artifact/host/ArtifactHostArchive.ts";
import { ExtensionDataCapabilityControl } from "../../../src/control/extension/ExtensionDataCapabilityControl.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("extension-data-capability");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const source = join(root, "source");
    const dataDirectory = join(root, "data");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "payload.txt"), "provider payload\n", "utf8");
    const bundle = join(root, "provider.dsprovider");
    await createArtifactDirectoryArchive(source, bundle);
    return { bundle, dataDirectory, root, source };
}

test("Extension data capability installs one immutable content-addressed bundle and reuses it", async (t) => {
    const h = await harness(t);
    const capability = new ExtensionDataCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });

    const first = await capability.installBundle(h.bundle);
    const second = await capability.installBundle(h.bundle);

    assert.match(first.generation, /^sha256-[0-9a-f]{64}$/u);
    assert.equal(second.generation, first.generation);
    assert.equal(second.directory, first.directory);
    assert.equal(await readFile(join(first.directory, "payload.txt"), "utf8"), "provider payload\n");
    await assert.rejects(access(join(h.dataDirectory, ".bundle-staging-does-not-exist")));
});

test("Extension data capability refuses undeclared access and symlink sources", async (t) => {
    const h = await harness(t);
    const denied = new ExtensionDataCapabilityControl({
        allowed: false,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });
    await assert.rejects(denied.installBundle(h.bundle), /did not declare the data capability/u);

    const link = join(h.root, "provider-link.dsprovider");
    await symlink(h.bundle, link);
    const allowed = new ExtensionDataCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });
    await assert.rejects(allowed.installBundle(link), /regular file, not a symlink/u);
});

test("Extension data capability removes only a validated bundle generation", async (t) => {
    const h = await harness(t);
    const capability = new ExtensionDataCapabilityControl({
        allowed: true,
        dataDirectory: h.dataDirectory,
        extensionId: "agent"
    });
    const installed = await capability.installBundle(h.bundle);

    await capability.removeBundle(installed.generation);
    await assert.rejects(access(installed.directory));
    await assert.rejects(capability.removeBundle("../escape"), /Invalid Extension data bundle generation/u);
});
