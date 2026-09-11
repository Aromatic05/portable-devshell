import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./builtin/index.js";
export * from "./builtin/StorageDowngrade.js";

export function storageExtensionDirectory(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "builtin");
}
