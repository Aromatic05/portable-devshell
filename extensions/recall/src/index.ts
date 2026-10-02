import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./builtin/index.js";
export * from "./builtin/RecallCommand.js";
export * from "./builtin/RecallService.js";

export function recallExtensionDirectory(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "builtin");
}
