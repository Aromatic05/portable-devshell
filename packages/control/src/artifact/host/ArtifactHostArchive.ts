import { once } from "node:events";
import {
    constants,
    createReadStream,
    createWriteStream
} from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readdir,
    utimes
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { createZstdCompress, createZstdDecompress } from "node:zlib";

import { createBLAKE3 } from "hash-wasm";
import { extract, pack, type Headers, type Pack } from "tar-stream";

import { createError, errorCodes } from "@portable-devshell/shared";

import { createArtifactHasher, updateManifestHash } from "./ArtifactHostHash.js";

interface SourceEntry {
    absolutePath: string;
    entryType: "directory" | "file";
    mode: number;
    modifiedAtSeconds: number;
    relativePath: string;
    size: number;
}

interface ManifestEntry {
    contentBlake3?: string;
    entryType: "directory" | "file";
    mode: number;
    modifiedAtSeconds: number;
    relativePath: string;
    size: number;
}

export interface ArtifactDirectoryManifestResult {
    entryCount: number;
    logicalBytes: number;
    manifestBlake3: string;
}

export async function createArtifactDirectoryArchive(
    sourcePath: string,
    targetPath: string
): Promise<ArtifactDirectoryManifestResult> {
    const entries = await collectEntries(sourcePath);
    const archive = pack();
    const output = pipeline(archive, createZstdCompress(), createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
    const manifestHasher = await createArtifactHasher();
    let logicalBytes = 0;

    try {
        for (const entry of entries) {
            if (entry.entryType === "directory") {
                await appendDirectory(archive, entry);
                updateManifestHash(manifestHasher, entry);
                continue;
            }
            const contentBlake3 = await appendFile(archive, entry);
            updateManifestHash(manifestHasher, { ...entry, contentBlake3 });
            logicalBytes += entry.size;
        }
        archive.finalize();
        await output;
    } catch (error) {
        archive.destroy(error instanceof Error ? error : new Error(String(error)));
        await output.catch(() => undefined);
        throw error;
    }

    return {
        entryCount: entries.length,
        logicalBytes,
        manifestBlake3: manifestHasher.digest("hex")
    };
}

export async function extractArtifactDirectoryArchive(
    archivePath: string,
    targetDirectory: string
): Promise<ArtifactDirectoryManifestResult> {
    const parser = extract();
    const manifestEntries: ManifestEntry[] = [];
    const seen = new Set<string>();
    const directories: Array<{ mode: number; modifiedAtSeconds: number; path: string; relativePath: string }> = [];
    let logicalBytes = 0;
    let entryFailure: unknown;

    parser.on("entry", (header, stream, next) => {
        void extractEntry(header, stream, targetDirectory, seen, directories)
            .then((entry) => {
                manifestEntries.push(entry);
                if (entry.entryType === "file") {
                    logicalBytes += entry.size;
                }
                next();
            })
            .catch((error: unknown) => {
                entryFailure = error;
                parser.destroy(error instanceof Error ? error : new Error(String(error)));
            });
    });

    try {
        await pipeline(createReadStream(archivePath), createZstdDecompress(), parser);
    } catch (error) {
        throw entryFailure ?? artifactError("artifact.payloadInvalid", "Invalid directory archive.", error);
    }

    directories.sort((left, right) => depth(right.relativePath) - depth(left.relativePath));
    for (const directory of directories) {
        await chmod(directory.path, directory.mode);
        const timestamp = new Date(directory.modifiedAtSeconds * 1000);
        await utimes(directory.path, timestamp, timestamp);
    }

    manifestEntries.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
    const manifestHasher = await createArtifactHasher();
    for (const entry of manifestEntries) {
        updateManifestHash(manifestHasher, entry);
    }
    return {
        entryCount: manifestEntries.length,
        logicalBytes,
        manifestBlake3: manifestHasher.digest("hex")
    };
}

async function collectEntries(root: string): Promise<SourceEntry[]> {
    const entries: SourceEntry[] = [];
    await collectDirectory(root, root, entries);
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
    return entries;
}

async function collectDirectory(root: string, current: string, output: SourceEntry[]): Promise<void> {
    const names = await readdir(current, { encoding: "buffer" });
    names.sort(Buffer.compare);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const encodedName of names) {
        let name: string;
        try {
            name = decoder.decode(encodedName);
        } catch (error) {
            throw artifactError("artifact.directoryUnsafe", "Directory contains a non-UTF-8 path.", error);
        }
        if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
            throw artifactError("artifact.directoryUnsafe", `Unsafe directory member: ${name}`);
        }
        const absolutePath = join(current, name);
        const metadata = await lstat(absolutePath);
        if (metadata.isSymbolicLink()) {
            throw artifactError("artifact.directoryUnsafe", `Directory contains symbolic link: ${name}`);
        }
        const relativePath = absolutePath.slice(root.length + 1).split("\\").join("/");
        validateRelativePath(relativePath);
        const base = {
            absolutePath,
            mode: metadata.mode & 0o777,
            modifiedAtSeconds: Math.floor(metadata.mtimeMs / 1000),
            relativePath
        };
        if (metadata.isDirectory()) {
            output.push({ ...base, entryType: "directory", size: 0 });
            await collectDirectory(root, absolutePath, output);
        } else if (metadata.isFile()) {
            output.push({ ...base, entryType: "file", size: metadata.size });
        } else {
            throw artifactError("artifact.directoryUnsafe", `Directory contains unsupported member: ${relativePath}`);
        }
    }
}

async function appendDirectory(archive: Pack, entry: SourceEntry): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        archive.entry(header(entry), (error) => (error ? reject(error) : resolve()));
    });
}

async function appendFile(archive: Pack, entry: SourceEntry): Promise<string> {
    const source = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await source.stat();
    if (!current.isFile() || current.size !== entry.size) {
        await source.close();
        throw artifactError("artifact.directoryChanged", `Directory member changed: ${entry.relativePath}`);
    }
    const hasher = await createBLAKE3();
    hasher.init();
    let position = 0;
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
        complete = resolve;
        fail = reject;
    });
    const tarEntry = archive.entry(header(entry), (error) => {
        if (error) {
            fail(error);
            return;
        }
        complete();
    });
    try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (position < entry.size) {
            const requested = Math.min(buffer.length, entry.size - position);
            const { bytesRead } = await source.read(buffer, 0, requested, position);
            if (bytesRead <= 0) {
                throw artifactError("artifact.directoryChanged", `Directory member changed: ${entry.relativePath}`);
            }
            const bytes = buffer.subarray(0, bytesRead);
            hasher.update(bytes);
            if (!tarEntry.write(bytes)) {
                await once(tarEntry, "drain");
            }
            position += bytesRead;
        }
        tarEntry.end();
        await completed;
        return hasher.digest("hex");
    } finally {
        await source.close();
    }
}

function header(entry: SourceEntry): Headers {
    return {
        gid: 0,
        gname: "",
        mode: entry.mode,
        mtime: new Date(entry.modifiedAtSeconds * 1000),
        name: entry.relativePath,
        size: entry.size,
        type: entry.entryType,
        uid: 0,
        uname: ""
    };
}

async function extractEntry(
    header: Headers,
    stream: Readable,
    targetDirectory: string,
    seen: Set<string>,
    directories: Array<{ mode: number; modifiedAtSeconds: number; path: string; relativePath: string }>
): Promise<ManifestEntry> {
    const relativePath =
        header.type === "directory" && header.name.endsWith("/")
            ? header.name.slice(0, -1)
            : header.name;
    validateRelativePath(relativePath);
    if (!seen.add(relativePath)) {
        throw artifactError("artifact.directoryUnsafe", `Duplicate archive member: ${relativePath}`);
    }
    const entryType = header.type === "directory" ? "directory" : header.type === "file" ? "file" : undefined;
    if (entryType === undefined) {
        throw artifactError("artifact.directoryUnsafe", `Unsupported archive member type: ${String(header.type)}`);
    }
    const mode = (header.mode ?? 0o644) & 0o777;
    const modifiedAtSeconds = Math.floor((header.mtime?.getTime() ?? 0) / 1000);
    const outputPath = join(targetDirectory, ...relativePath.split("/"));

    if (entryType === "directory") {
        await drain(stream);
        await mkdir(outputPath, { recursive: true, mode: 0o700 });
        directories.push({ mode, modifiedAtSeconds, path: outputPath, relativePath });
        return { entryType, mode, modifiedAtSeconds, relativePath, size: 0 };
    }

    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const hasher = await createBLAKE3();
    hasher.init();
    let size = 0;
    const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            hasher.update(chunk);
            size += chunk.length;
            callback(null, chunk);
        }
    });
    await pipeline(stream, hashing, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    if (header.size !== undefined && size !== header.size) {
        throw artifactError("artifact.payloadInvalid", `Archive member size mismatch: ${relativePath}`);
    }
    await chmod(outputPath, mode);
    const timestamp = new Date(modifiedAtSeconds * 1000);
    await utimes(outputPath, timestamp, timestamp);
    return {
        contentBlake3: hasher.digest("hex"),
        entryType,
        mode,
        modifiedAtSeconds,
        relativePath,
        size
    };
}

async function drain(stream: Readable): Promise<void> {
    stream.resume();
    await once(stream, "end");
}

function validateRelativePath(path: string): void {
    const segments = path.split("/");
    if (
        path.length === 0 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
        throw artifactError("artifact.directoryUnsafe", `Unsafe archive member path: ${path}`);
    }
}

function depth(path: string): number {
    return path.split("/").length;
}

function artifactError(code: string, message: string, cause?: unknown) {
    return createError({
        code,
        message: cause instanceof Error ? `${message} ${cause.message}` : message,
        retryable: false
    });
}
