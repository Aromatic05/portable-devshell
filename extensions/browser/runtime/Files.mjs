import { readdir, stat, realpath, mkdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Only the dedicated CLI output tree is exportable; Chromium state is separate. */
export async function listFiles(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await realpath(directory);
    const entries = [];
    async function walk(current) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            if (entry.name.startsWith(".credentials-") || entry.isSymbolicLink()) continue;
            const file = join(current, entry.name);
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile()) {
                const path = relative(root, await realpath(file));
                if (path.startsWith(".." + sep) || path === "..") continue;
                entries.push({ path: path.split(sep).join("/"), bytes: (await stat(file)).size });
            }
        }
    }
    await walk(root);
    return { directory: root, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
}
