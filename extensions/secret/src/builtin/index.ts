import type { ExtensionActivation } from "@portable-devshell/extension";

import { executeSecretCommand } from "./SecretCommand.js";

export * from "./SecretScan.js";
export { executeSecretCommand, SECRET_USAGE } from "./SecretCommand.js";

export function activate(): ExtensionActivation {
    return {
        command: async (argv, invocation) => await executeSecretCommand(argv, invocation),
        dispose() {}
    };
}
