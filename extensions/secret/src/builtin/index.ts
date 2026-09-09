import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands, nativeCommands } from "@portable-devshell/extension/cli";

import { executeSecretCommand } from "./SecretCommand.js";
import { executeSecretModelCommand } from "./SecretModelCommand.js";

export * from "./SecretScan.js";
export { executeSecretCommand, SECRET_USAGE } from "./SecretCommand.js";
export { executeSecretModelCommand, SECRET_MODEL_USAGE } from "./SecretModelCommand.js";

export function activate(context: ExtensionContext): void {
    context.register(
        nativeCommands,
        "secret",
        async (argv, invocation) => await executeSecretCommand(argv, invocation)
    );
    context.register(
        modelCommands,
        "secret",
        async (argv, invocation) => await executeSecretModelCommand(context, argv, invocation)
    );
}
