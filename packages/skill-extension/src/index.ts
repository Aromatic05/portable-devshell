import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./builtin/index.js";

/**
 * Thin builtin payload root for the currently executing package form.
 * Source mode resolves to src/builtin; compiled mode resolves to dist/builtin.
 */
export function skillExtensionDirectory(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "builtin");
}
