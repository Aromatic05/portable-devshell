import { readdirSync, rmSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function cleanupStaleAtomicStateTemps(
    filePath: string,
    exists: (pid: number) => boolean = processExists,
): void {
    const directory = dirname(filePath);
    const prefix = `${basename(filePath)}.tmp.`;
    let entries: Dirent[];
    try {
        entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        return;
    }

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const suffix = entry.name.slice(prefix.length);
        const separator = suffix.indexOf(".");
        if (separator <= 0) continue;
        const pidText = suffix.slice(0, separator);
        const nonce = suffix.slice(separator + 1);
        if (!/^\d+$/u.test(pidText) || !UUID_PATTERN.test(nonce)) continue;
        const pid = Number(pidText);
        if (!Number.isSafeInteger(pid) || pid < 1 || exists(pid)) continue;
        try {
            rmSync(join(directory, entry.name), { force: true });
        } catch {
            // Crash residue cleanup is best-effort and must never block state recovery.
        }
    }
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}
