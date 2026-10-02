import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands } from "@portable-devshell/extension/cli";

import { executeInstanceCommand } from "./InstanceCommand.js";

export { executeInstanceCommand, INSTANCE_USAGE } from "./InstanceCommand.js";

export function activate(context: ExtensionContext): void {
    const instances = context.capabilities.instanceObserve;
    if (instances === undefined)
        throw new Error(
            "Instance Extension requires the instanceObserve capability.",
        );
    context.register(
        modelCommands,
        "instance",
        async (argv, invocation) =>
            await executeInstanceCommand(instances, argv, invocation),
    );
}
