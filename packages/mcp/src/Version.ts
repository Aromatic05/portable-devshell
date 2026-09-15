import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePortableDevshellApplicationVersion(startUrl = import.meta.url): string {
    let directory = dirname(fileURLToPath(startUrl));
    while (true) {
        const manifestPath = join(directory, "package.json");
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                name?: unknown;
                version?: unknown;
            };
            if (manifest.name === "portable-devshell") {
                if (typeof manifest.version !== "string" || manifest.version.length === 0) {
                    throw new Error(`Application package version is invalid: ${manifestPath}`);
                }
                return manifest.version;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error("Cannot locate portable-devshell application package manifest.");
}
