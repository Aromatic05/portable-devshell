import type { ExtensionContext } from "@portable-devshell/extension";
import {
    modelCommands,
    nativeCommands,
} from "@portable-devshell/extension/cli";

import {
    executeRecallModelCommand,
    executeRecallNativeCommand,
} from "./RecallCommand.js";
import { RecallService } from "./RecallService.js";

export function activate(context: ExtensionContext): void {
    const service = new RecallService(context);
    context.register(
        nativeCommands,
        "recall",
        async (argv, invocation) =>
            await executeRecallNativeCommand(service, argv, invocation),
    );
    context.register(
        modelCommands,
        "recall",
        async (argv, invocation) =>
            await executeRecallModelCommand(service, argv, invocation),
    );
}
