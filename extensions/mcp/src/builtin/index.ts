import type { ExtensionContext } from "@portable-devshell/extension";
import { commands } from "@portable-devshell/extension/cli";

import { createMcpCommandRuntime, executeMcpCommand } from "./McpCommand.js";

export * from "./McpClientRuntime.js";
export * from "./McpCommand.js";
export * from "./McpProfileStore.js";

export function activate(context: ExtensionContext): void {
    const runtime = createMcpCommandRuntime(context.paths.stateDirectory, context.version);
    context.register(
        commands,
        "mcp",
        async (argv, invocation) => await executeMcpCommand(runtime, argv, invocation)
    );
}
