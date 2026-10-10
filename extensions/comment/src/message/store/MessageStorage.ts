import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/**
 * Move the current message database into extension-owned storage without
 * copying a potentially incomplete SQLite WAL file. The source is kept as a
 * recovery copy; the destination is published atomically and never replaced.
 */
export async function migrateMessageDatabase(options: {
    instance: string;
    targetFile: string;
    sourceFile?: string;
}): Promise<void> {
    const { instance, targetFile } = options;
    // Historical filenames used the raw instance name as a directory member.
    // Never interpret path separators or parent directories from a name.
    if (basename(instance) !== instance || instance === "." || instance === "..") {
        return;
    }
    const sourceFile = options.sourceFile ?? join(
        homedir(), ".devshell", instance, "control-worker", "message.sqlite3",
    );
    if (sourceFile === targetFile || existsSync(targetFile) || !existsSync(sourceFile)) {
        return;
    }
    await mkdir(dirname(targetFile), { recursive: true });
    const temporaryFile = `${targetFile}.${randomUUID()}.migrating`;
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try {
        await backup(source, temporaryFile);
        try {
            await link(temporaryFile, targetFile);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    } finally {
        source.close();
        await unlink(temporaryFile).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
    }
}
