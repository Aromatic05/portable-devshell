import type { ExtensionContext } from "@portable-devshell/extension";
import { nativeCommands } from "@portable-devshell/extension/cli";
import { applications } from "@portable-devshell/extension/web";

import { executeAccessCommand } from "./AccessCommand.js";
import { AccessRuntime } from "./AccessRuntime.js";

let activeRuntime: AccessRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (activeRuntime !== undefined)
        throw new Error("Access Extension is already active in this generation.");
    const runtime = new AccessRuntime(context);
    activeRuntime = runtime;
    context.register(
        nativeCommands,
        "access",
        async (argv, invocation) =>
            await executeAccessCommand(runtime, argv, invocation),
    );
    context.register(
        applications,
        "access",
        Object.freeze({
            source: Object.freeze({
                kind: "endpoint" as const,
                resolve: async () => await runtime.webUpstream(),
            }),
        }),
    );
}

export async function deactivate(): Promise<void> {
    const runtime = activeRuntime;
    activeRuntime = undefined;
    await runtime?.dispose();
}

export { AccessRuntime } from "./AccessRuntime.js";
export { executeAccessCommand, ACCESS_USAGE } from "./AccessCommand.js";
