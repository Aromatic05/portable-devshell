import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative as relativePath } from "node:path";
import test from "node:test";

import {
    createArtifactDirectoryArchive,
    extractArtifactDirectoryArchive
} from "../../src/control/artifact/host/ArtifactHostArchive.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("directory archive treats absolute, relative, and trailing-separator roots identically", async (t) => {
    const root = await createTestTempDirectory("artifact-host-archive-root");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const source = join(root, "source");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "devshell-extension.json"), "manifest\n", "utf8");
    await writeFile(join(source, "nested", "entry.txt"), "entry\n", "utf8");

    const variants = [
        source,
        `${source}/`,
        relativePath(process.cwd(), source)
    ];
    const manifests = [];
    for (const [index, variant] of variants.entries()) {
        const archive = join(root, `archive-${index}.tar.zst`);
        const output = join(root, `output-${index}`);
        await mkdir(output);
        manifests.push(await createArtifactDirectoryArchive(variant, archive));
        await extractArtifactDirectoryArchive(archive, output);
        assert.deepEqual(await tree(output), ["devshell-extension.json", "nested/", "nested/entry.txt"]);
        assert.equal(await readFile(join(output, "devshell-extension.json"), "utf8"), "manifest\n");
    }
    assert.deepEqual(manifests[1], manifests[0]);
    assert.deepEqual(manifests[2], manifests[0]);
});

async function tree(root: string): Promise<string[]> {
    const output: string[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                output.push(`${path}/`);
                await walk(join(directory, entry.name), path);
            } else {
                output.push(path);
            }
        }
    }
    await walk(root, "");
    return output;
}
