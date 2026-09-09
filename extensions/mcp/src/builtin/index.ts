import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands, nativeCommands } from "@portable-devshell/extension/cli";

import { createMcpCommandRuntime, executeMcpCommand, executeMcpModelCommand } from "./McpCommand.js";

export * from "./McpClientRuntime.js";
export * from "./McpCommand.js";
export * from "./McpProfileStore.js";

export function activate(context: ExtensionContext): void {
    const runtime = createMcpCommandRuntime(context.paths.stateDirectory, context.version);
    context.register(
        nativeCommands,
        "mcp",
        async (argv, invocation) => await executeMcpCommand(runtime, argv, invocation)
    );
    context.register(
        modelCommands,
        "mcp",
        async (argv, invocation) => await executeMcpModelCommand(runtime, argv, invocation)
    );
}
