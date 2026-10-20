import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";

export class ConfigLockCommitError extends Error {
    constructor(error: unknown) {
        super("Configuration lease metadata could not be committed.", { cause: error });
    }
}

// SQLite owns the cross-process lease. A crash closes the connection and
// releases it, so recovery never needs PID guesses or a stale-lock timeout.
export async function withConfigLock<T>(
    directory: string,
    operation: (database: DatabaseSync) => Promise<T>,
): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, ".config-lock.sqlite");
    const database = new DatabaseSync(file);
    try {
        if (process.platform !== "win32") await chmod(file, 0o600);
        for (;;) {
            try {
                database.exec("BEGIN IMMEDIATE");
                break;
            } catch (error) {
                if (!(error instanceof Error && "errcode" in error && error.errcode === 5)) throw error;
                // Never block the event loop: another Store in this process
                // may own the lease while awaiting filesystem operations.
                await setTimeout(10);
            }
        }
        database.exec("CREATE TABLE IF NOT EXISTS protected_instances (file TEXT PRIMARY KEY)");
        const result = await operation(database);
        try {
            database.exec("COMMIT");
        } catch (error) {
            throw new ConfigLockCommitError(error);
        }
        return result;
    } finally {
        // Closing rolls back an unfinished metadata transaction and always
        // releases the lease, including when filesystem recovery failed.
        database.close();
    }
}
