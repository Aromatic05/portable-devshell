import type { ExtensionContext } from "@portable-devshell/extension";
import {
    modelCommands,
    nativeCommands,
} from "@portable-devshell/extension/cli";
import { rewrite } from "@portable-devshell/extension/toolcall";

import { executeSecretCommand } from "./command/SecretCommand.js";
import { executeSecretModelCommand } from "./command/SecretModelCommand.js";
import { createSecretRewrite } from "./rewrite/SecretRewrite.js";

export function activate(context: ExtensionContext): void {
    context.register(
        nativeCommands,
        "secret",
        async (argv, invocation) =>
            await executeSecretCommand(argv, invocation),
    );
    context.register(
        modelCommands,
        "secret",
        async (argv, invocation) =>
            await executeSecretModelCommand(context, argv, invocation),
    );
    context.register(rewrite, "secret", createSecretRewrite());
}
