import type { ExtensionContext } from "@portable-devshell/extension";
import { commands } from "@portable-devshell/extension/cli";

import { executeSecretCommand } from "./SecretCommand.js";

export * from "./SecretScan.js";
export { executeSecretCommand, SECRET_USAGE } from "./SecretCommand.js";

export function activate(context: ExtensionContext): void {
    context.register(
        commands,
        "secret",
        async (argv, invocation) => await executeSecretCommand(argv, invocation)
    );
}
