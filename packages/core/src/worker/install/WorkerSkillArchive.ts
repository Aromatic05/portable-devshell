import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { pack, type Headers, type Pack } from "tar-stream";

export interface WorkerSkillArchive {
    bytes: Buffer;
    sha256: string;
}

interface SkillEntry {
    absolutePath: string;
    relativePath: string;
    type: "directory" | "file";
}

export async function createWorkerSkillArchive(sourceDirectory: string): Promise<WorkerSkillArchive | undefined> {
    let source;
    try {
        source = await lstat(sourceDirectory);
    } catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
    if (!source.isDirectory()) {
        throw new Error(`Skill source is not a directory: ${sourceDirectory}`);
    }

    const entries: SkillEntry[] = [];
    await collectSkillEntries(sourceDirectory, sourceDirectory, entries);
    const archive = pack();
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const completed = new Promise<void>((resolve, reject) => {
        archive.once("end", resolve);
        archive.once("error", reject);
    });

    try {
        for (const entry of entries) {
            if (entry.type === "directory") {
                await appendEntry(
                    archive,
                    skillHeader(
                        entry,
                        portableSkillMode(entry),
                    ),
                );
            } else {
                const content = await readFile(entry.absolutePath);
                await appendEntry(
                    archive,
                    skillHeader(
                        entry,
                        portableSkillMode(entry, content),
                    ),
                    content,
                );
            }
        }
        archive.finalize();
        await completed;
    } catch (error) {
        archive.destroy(
            error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
    }

    const bytes = Buffer.concat(chunks);
    return {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}

async function collectSkillEntries(
    root: string,
    current: string,
    output: SkillEntry[],
): Promise<void> {
    const names = await readdir(current);
    names.sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    for (const name of names) {
        if (
            name.length === 0 ||
            name === "." ||
            name === ".." ||
            name.includes("/") ||
            name.includes("\\")
        ) {
            throw new Error(
                `Skill directory contains an unsafe member: ${name}`,
            );
        }
        const absolutePath = join(current, name);
        const metadata = await lstat(absolutePath);
        const relativePath = absolutePath
            .slice(root.length + 1)
            .split("\\")
            .join("/");
        if (metadata.isSymbolicLink()) {
            throw new Error(
                `Skill directory contains a symbolic link: ${relativePath}`,
            );
        }
        if (metadata.isDirectory()) {
            output.push({
                absolutePath,
                relativePath,
                type: "directory",
            });
            await collectSkillEntries(root, absolutePath, output);
            continue;
        }
        if (metadata.isFile()) {
            output.push({
                absolutePath,
                relativePath,
                type: "file",
            });
            continue;
        }
        throw new Error(
            `Skill directory contains an unsupported member: ${relativePath}`,
        );
    }
}

function portableSkillMode(
    entry: SkillEntry,
    content?: Buffer,
): number {
    if (entry.type === "directory") {
        return 0o755;
    }
    return content?.subarray(0, 2).equals(Buffer.from("#!")) === true
        ? 0o755
        : 0o644;
}

function skillHeader(entry: SkillEntry, mode: number): Headers {
    return {
        gid: 0,
        gname: "",
        mode,
        mtime: new Date(0),
        name:
            entry.type === "directory"
                ? `${entry.relativePath}/`
                : entry.relativePath,
        type: entry.type,
        uid: 0,
        uname: "",
    };
}

async function appendEntry(
    archive: Pack,
    header: Headers,
    content?: Buffer,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        archive.entry(header, content, (error) =>
            error ? reject(error) : resolve(),
        );
    });
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
    );
}
