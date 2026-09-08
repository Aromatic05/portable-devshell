import type { ExtensionActivation, ExtensionContext } from "@portable-devshell/extension";

import { createMcpCommandRuntime, executeMcpCommand } from "./McpCommand.js";

export * from "./McpClientRuntime.js";
export * from "./McpCommand.js";
export * from "./McpProfileStore.js";

export function activate(context: ExtensionContext): ExtensionActivation {
    const runtime = createMcpCommandRuntime(context.paths.stateDirectory, context.version);
    return {
        command: async (argv, invocation) => await executeMcpCommand(runtime, argv, invocation),
        dispose() {}
    };
}
