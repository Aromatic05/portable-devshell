import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative as relativePath } from "node:path";
import { createWriteStream } from "node:fs";
import { createZstdCompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { pack } from "tar-stream";

import {
    createArtifactDirectoryArchive,
    extractArtifactDirectoryArchive,
} from "../../../../../src/artifact/Archive.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";

test("directory archive treats absolute, relative, and trailing-separator roots identically", async (t) => {
    const root = await createTestTempDirectory("artifact-host-archive-root");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const source = join(root, "source");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(
        join(source, "devshell-extension.json"),
        "manifest\n",
        "utf8",
    );
    await writeFile(join(source, "nested", "entry.txt"), "entry\n", "utf8");

    const variants = [
        source,
        `${source}/`,
        relativePath(process.cwd(), source),
    ];
    const manifests = [];
    for (const [index, variant] of variants.entries()) {
        const archive = join(root, `archive-${index}.tar.zst`);
        const output = join(root, `output-${index}`);
        await mkdir(output);
        manifests.push(await createArtifactDirectoryArchive(variant, archive));
        await extractArtifactDirectoryArchive(archive, output);
        assert.deepEqual(await tree(output), [
            "devshell-extension.json",
            "nested/",
            "nested/entry.txt",
        ]);
        assert.equal(
            await readFile(join(output, "devshell-extension.json"), "utf8"),
            "manifest\n",
        );
    }
    assert.deepEqual(manifests[1], manifests[0]);
    assert.deepEqual(manifests[2], manifests[0]);
});

test("directory archive creation rejects a symbolic link without reading its outside target", async (t) => {
    const root = await createTestTempDirectory("artifact-archive-symlink");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const source = join(root, "source");
    const outside = join(root, "outside-secret.txt");
    await mkdir(source);
    await writeFile(outside, "outside bytes", "utf8");
    await import("node:fs/promises").then(({ symlink }) =>
        symlink(outside, join(source, "link.txt")),
    );

    await assert.rejects(
        createArtifactDirectoryArchive(source, join(root, "archive.tar.zst")),
        (error: unknown) => (error as { code?: string }).code === "artifact.directoryUnsafe",
    );
    assert.equal(await readFile(outside, "utf8"), "outside bytes");
});

test("directory archive extraction rejects traversal before writing outside the workspace", async (t) => {
    const root = await createTestTempDirectory("artifact-archive-traversal");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const output = join(root, "workspace", "unpack");
    const outside = join(root, "workspace", "escaped.txt");
    const archivePath = join(root, "malicious.tar.zst");
    await mkdir(output, { recursive: true });
    const archive = pack();
    const writing = pipeline(
        archive,
        createZstdCompress(),
        createWriteStream(archivePath, { flags: "wx" }),
    );
    await new Promise<void>((resolve, reject) => {
        archive.entry(
            { name: "../escaped.txt", size: 13, type: "file", mode: 0o600 },
            "malicious data",
            (error) => (error ? reject(error) : resolve()),
        );
    });
    archive.finalize();
    await writing;

    await assert.rejects(
        extractArtifactDirectoryArchive(archivePath, output),
        (error: unknown) => (error as { code?: string }).code === "artifact.directoryUnsafe",
    );
    await assert.rejects(readFile(outside), { code: "ENOENT" });
    assert.deepEqual(await tree(output), []);
});

test("directory archive extraction refuses to overwrite an existing workspace file", async (t) => {
    const root = await createTestTempDirectory("artifact-archive-overwrite");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const output = join(root, "unpack");
    const existing = join(output, "result.txt");
    const archivePath = join(root, "incoming.tar.zst");
    await mkdir(output);
    await writeFile(existing, "user data", "utf8");
    const archive = pack();
    const writing = pipeline(
        archive,
        createZstdCompress(),
        createWriteStream(archivePath, { flags: "wx" }),
    );
    await new Promise<void>((resolve, reject) => {
        archive.entry(
            { name: "result.txt", size: 13, type: "file", mode: 0o600 },
            "incoming data",
            (error) => (error ? reject(error) : resolve()),
        );
    });
    archive.finalize();
    await writing;

    await assert.rejects(extractArtifactDirectoryArchive(archivePath, output));
    assert.equal(await readFile(existing, "utf8"), "user data");
});

async function tree(root: string): Promise<string[]> {
    const output: string[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const path =
                prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
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
