import { join } from "node:path";

import type { ExtensionContext } from "@portable-devshell/extension";
import { nativeCommands } from "@portable-devshell/extension/cli";
import { applications } from "@portable-devshell/extension/web";

import { executeAgentCommand } from "./AgentCommand.js";
import { AgentExtensionRuntime } from "./AgentRuntime.js";
import { AgentProviderLoader } from "./provider/AgentProviderLoader.js";
import { AgentProviderManager } from "./provider/AgentProviderManager.js";
import { AgentProviderRegistry } from "./provider/AgentProviderRegistry.js";
import { AgentProviderRegistryStore } from "./provider/AgentProviderRegistryStore.js";

let activeRuntime: AgentExtensionRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (activeRuntime !== undefined) throw new Error("Agent Extension is already active in this generation.");
    const providerStore = new AgentProviderRegistryStore(join(context.paths.stateDirectory, "providers.json"));
    const providerLoader = new AgentProviderLoader(context, undefined, providerStore);
    const providers = await providerLoader.loadSelected();
    const providerRegistry = new AgentProviderRegistry(providers);
    const runtime = new AgentExtensionRuntime(context, { registry: providerRegistry });
    const providerManager = new AgentProviderManager({
        context,
        isProviderInUse: (id) => runtime.isProviderInUse(id),
        loader: providerLoader,
        registry: providerRegistry,
        store: providerStore
    });
    activeRuntime = runtime;
    context.register(
        nativeCommands,
        "agent",
        async (argv, invocation) => await executeAgentCommand(runtime, providerManager, argv, invocation)
    );
    context.register(applications, "agent", Object.freeze({
        source: Object.freeze({
            kind: "endpoint" as const,
            resolve: () => runtime.webUpstream()
        })
    }));
}

export async function deactivate(): Promise<void> {
    const runtime = activeRuntime;
    activeRuntime = undefined;
    await runtime?.dispose();
}
