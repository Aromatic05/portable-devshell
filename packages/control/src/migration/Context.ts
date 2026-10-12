import { readFile } from "node:fs/promises";

import { ControlPathHome } from "@portable-devshell/shared";

import {
    isDocument,
    migrateContextDocument,
    parseRecord,
    upgradeContextDocument,
} from "../context/registry/Record.js";

/** Inspect legacy Context state without rewriting it before the installer
 * has stopped the old Control and captured a recoverable snapshot.
 */
export async function inspectContextMigration(
    homeDirectory?: string,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<{ filePath: string; required: boolean }> {
    const filePath = new ControlPathHome(homeDirectory, environment).contextsFile;
    const source = await readFile(filePath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        },
    );
    if (source === undefined) return { filePath, required: false };
    const document: unknown = JSON.parse(source);
    if (
        typeof document !== "object" || document === null ||
        Array.isArray(document)
    ) {
        throw new Error(`Invalid Context registry: ${filePath}`);
    }
    const version = (document as { version?: unknown }).version;
    if (version !== 1 && version !== 2) {
        throw new Error(`Unsupported Context registry schema version: ${String(version)}.`);
    }
    const migrated = version === 1 ? migrateContextDocument(document) : document;
    if (!isDocument(migrated) || migrated.contexts.some((record) =>
        parseRecord(record) === undefined
    )) {
        throw new Error(`Invalid Context registry records: ${filePath}`);
    }
    return { filePath, required: version === 1 };
}

export async function migrateContextState(
    homeDirectory?: string,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
    const inspection = await inspectContextMigration(homeDirectory, environment);
    if (!inspection.required) return false;
    await upgradeContextDocument(inspection.filePath);
    return true;
}
