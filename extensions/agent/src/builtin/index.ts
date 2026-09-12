import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands, nativeCommands } from "@portable-devshell/extension/cli";
import { applications } from "@portable-devshell/extension/web";

import { executeAgentCommand } from "./AgentCommand.js";
import { executeAgentModelCommand } from "./AgentModelCommand.js";
import { AgentExtensionRuntime } from "./AgentRuntime.js";
import { AgentProviderLoader } from "./provider/AgentProviderLoader.js";
import { AgentProviderManager } from "./provider/AgentProviderManager.js";
import { AgentProviderRegistry } from "./provider/AgentProviderRegistry.js";
import { AgentProviderRegistryStore } from "./provider/AgentProviderRegistryStore.js";
import { ensureBundledPiCommand } from "./pi/PiCommandInstaller.js";

let activeRuntime: AgentExtensionRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (activeRuntime !== undefined) throw new Error("Agent Extension is already active in this generation.");
    const providerStore = new AgentProviderRegistryStore(join(context.paths.stateDirectory, "providers.json"));
    const providerLoader = new AgentProviderLoader(context, undefined, providerStore);
    const providers = await providerLoader.loadSelected();
    const providerRegistry = new AgentProviderRegistry(providers);
    const bundledProviders = await findBundledProviders(context);
    let providerManager: AgentProviderManager;
    const runtime = new AgentExtensionRuntime(context, {
        registry: providerRegistry,
        resolveProvider: async (requested) => await providerManager.resolveProvider(requested)
    });
    providerManager = new AgentProviderManager({
        bundledProviders,
        context,
        isProviderInUse: (id) => runtime.isProviderInUse(id),
        loader: providerLoader,
        registry: providerRegistry,
        store: providerStore
    });
    for (const id of providerManager.bundledProviders()) {
        await providerManager.installBundled(id);
    }
    if (providerManager.bundledProviders().includes("pi")) {
        const command = await ensureBundledPiCommand(context);
        if (!command.installed) {
            context.logger.warn(
                command.reason === "collision"
                    ? `Bundled Pi is ready, but ${command.command} is owned by another installation and was not replaced.`
                    : "Bundled Pi is ready, but the packaged Pi launcher is missing; the pi command was not published."
            );
        }
    }
    activeRuntime = runtime;
    context.register(
        nativeCommands,
        "agent",
        async (argv, invocation) => await executeAgentCommand(runtime, providerManager, argv, invocation)
    );
    context.register(
        modelCommands,
        "agent",
        async (argv, invocation) => await executeAgentModelCommand(runtime, providerManager, argv, invocation)
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

async function findBundledProviders(context: ExtensionContext): Promise<Readonly<Record<string, string>>> {
    const root = join(context.paths.codeDirectory, "bundled-providers");
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
    });
    if (entries === undefined) return {};
    const providers: Record<string, string> = {};
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".dsprovider")) {
            throw new TypeError(`Bundled Agent provider ${entry.name} must be a plain .dsprovider file.`);
        }
        const id = entry.name.slice(0, -".dsprovider".length);
        if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
            throw new TypeError(`Invalid bundled Agent provider id: ${id}`);
        }
        const bundle = join(root, entry.name);
        const metadata = await lstat(bundle);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new TypeError(`Bundled Agent provider ${entry.name} must be a plain .dsprovider file.`);
        }
        providers[id] = bundle;
    }
    return Object.freeze(providers);
}

function isMissing(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT";
}
