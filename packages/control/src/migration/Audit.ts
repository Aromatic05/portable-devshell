import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { inspectAuditDatabase, migrateAuditDatabase } from "@portable-devshell/core";
import { ControlPathHome } from "@portable-devshell/shared";

/**
 * Discover all persisted Instance audit databases, including disabled Instances.
 * Never follow symlinked directories or files into unrelated user data.
 */
export async function inspectAuditMigration(
    homeDirectory?: string,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<{
    files: readonly string[];
    required: boolean;
}> {
    const root = dirname(new ControlPathHome(homeDirectory, environment).controlHomeDir);
    const files: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
        },
    )) {
        if (!entry.isDirectory() || entry.name === "control") continue;
        const workerDirectory = join(root, entry.name, "control-worker");
        const workerStats = await lstatIfExists(workerDirectory);
        if (workerStats === undefined) continue;
        if (!workerStats.isDirectory()) {
            throw new Error(`Audit directory is not a plain directory: ${workerDirectory}.`);
        }
        const filePath = join(workerDirectory, "audit.sqlite3");
        const stats = await lstatIfExists(filePath);
        if (stats === undefined) continue;
        if (!stats.isFile()) {
            throw new Error(`Audit database is not a plain file: ${filePath}.`);
        }
        files.push(filePath);
    }
    files.sort();
    let required = false;
    for (const file of files) {
        required = inspectAuditDatabase(file).changed || required;
    }
    return { files, required };
}

export async function migrateAuditState(
    homeDirectory?: string,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
    const inspection = await inspectAuditMigration(homeDirectory, environment);
    let changed = false;
    for (const file of inspection.files) {
        changed = migrateAuditDatabase(file) || changed;
    }
    return changed;
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    return await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
}
