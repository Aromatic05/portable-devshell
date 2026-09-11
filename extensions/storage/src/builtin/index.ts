import type { ExtensionContext } from "@portable-devshell/extension";
import { nativeCommands } from "@portable-devshell/extension/cli";

import { executeStorageCommand } from "./StorageCommand.js";

export { executeStorageCommand, STORAGE_USAGE } from "./StorageCommand.js";

export function activate(context: ExtensionContext): void {
    context.register(
        nativeCommands,
        "storage",
        async (argv, invocation) => await executeStorageCommand(argv, invocation),
    );
}
