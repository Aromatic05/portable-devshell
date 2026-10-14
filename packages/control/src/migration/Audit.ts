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
    deferredFiles: readonly string[];
    files: readonly string[];
    required: boolean;
}> {
    const root = dirname(new ControlPathHome(homeDirectory, environment).controlHomeDir);
    const files: string[] = [];
    const deferredFiles: string[] = [];
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
            deferredFiles.push(workerDirectory);
            console.warn(`Skipping non-directory Instance audit path: ${workerDirectory}`);
            continue;
        }
        const filePath = join(workerDirectory, "audit.sqlite3");
        const stats = await lstatIfExists(filePath);
        if (stats === undefined) continue;
        if (!stats.isFile()) {
            deferredFiles.push(filePath);
            console.warn(`Skipping non-file Instance audit path: ${filePath}`);
            continue;
        }
        files.push(filePath);
    }
    files.sort();
    let required = false;
    const readable: string[] = [];
    for (const file of files) {
        try {
            required = inspectAuditDatabase(file).changed || required;
            readable.push(file);
        } catch (error) {
            // Leave unsupported/damaged Instance audits untouched for recovery.
            deferredFiles.push(file);
            console.warn(`Deferring unavailable Instance audit database ${file}:`, error);
        }
    }
    deferredFiles.sort();
    return { deferredFiles, files: readable, required };
}

export async function migrateAuditState(
    homeDirectory?: string,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
    const inspection = await inspectAuditMigration(homeDirectory, environment);
    let changed = false;
    for (const file of inspection.files) {
        try {
            changed = migrateAuditDatabase(file) || changed;
        } catch (error) {
            console.warn(`Deferring failed Instance audit migration ${file}:`, error);
        }
    }
    return changed;
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    return await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
}
