import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionContext } from "@portable-devshell/extension";
import {
    modelCommands,
    nativeCommands,
} from "@portable-devshell/extension/cli";
import {
    pages as tuiPages,
    type TuiPageBinding,
    type TuiPageItem,
} from "@portable-devshell/extension/tui";
import {
    applications,
    pages as webPages,
    type WebPageBinding,
    type WebPageRow,
} from "@portable-devshell/extension/web";

import { executeAgentCommand } from "./AgentCommand.js";
import { executeAgentModelCommand } from "./AgentModelCommand.js";
import { AgentExtensionRuntime } from "./AgentRuntime.js";
import { AgentProviderLoader } from "./provider/AgentProviderLoader.js";
import {
    AgentProviderManager,
    type AgentProviderManagementRecord,
} from "./provider/AgentProviderManager.js";
import { AgentProviderRegistry } from "./provider/AgentProviderRegistry.js";
import { AgentProviderRegistryStore } from "./provider/AgentProviderRegistryStore.js";
import { ensureBundledPiCommand } from "./pi/PiCommandInstaller.js";

let activeRuntime: AgentExtensionRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (activeRuntime !== undefined)
        throw new Error(
            "Agent Extension is already active in this generation.",
        );
    const providerStore = new AgentProviderRegistryStore(
        join(context.paths.stateDirectory, "providers.json"),
    );
    const providerLoader = new AgentProviderLoader(
        context,
        undefined,
        providerStore,
    );
    const providers = await providerLoader.loadSelected();
    const providerRegistry = new AgentProviderRegistry(providers);
    const bundledProviders = await findBundledProviders(context);
    const runtime: AgentExtensionRuntime = new AgentExtensionRuntime(context, {
        registry: providerRegistry,
        resolveProvider: async (requested) =>
            await providerManager.resolveProvider(requested),
    });
    const providerManager: AgentProviderManager = new AgentProviderManager({
        bundledProviders,
        context,
        isProviderInUse: (id) => runtime.isProviderInUse(id),
        loader: providerLoader,
        registry: providerRegistry,
        store: providerStore,
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
                    : "Bundled Pi is ready, but the packaged Pi launcher is missing; the pi command was not published.",
            );
        }
    }
    activeRuntime = runtime;
    context.register(
        nativeCommands,
        "agent",
        async (argv, invocation) =>
            await executeAgentCommand(
                runtime,
                providerManager,
                argv,
                invocation,
            ),
    );
    context.register(
        modelCommands,
        "agent",
        async (argv, invocation) =>
            await executeAgentModelCommand(
                runtime,
                providerManager,
                argv,
                invocation,
            ),
    );
    context.register(
        applications,
        "agent",
        Object.freeze({
            source: Object.freeze({
                kind: "endpoint" as const,
                resolve: async () => await runtime.webUpstream(),
            }),
        }),
    );
    context.register(webPages, "agent", createAgentWebPage(providerManager));
    context.register(tuiPages, "agent", createAgentTuiPage(providerManager));
}

function createAgentWebPage(providers: AgentProviderManager): WebPageBinding {
    return async (request, invocation) => {
        invocation.signal.throwIfAborted();
        if (request.kind === "action") {
            throw new Error(
                "Agent provider mutations are restricted to the local Control owner.",
            );
        }
        const [records, defaultProvider] = await Promise.all([
            providers.list(),
            providers.getDefault(),
        ]);
        return {
            tables: [
                {
                    columns: [
                        { id: "provider", label: "Provider" },
                        { id: "version", label: "Version" },
                        { id: "state", label: "State" },
                        { id: "default", label: "Default" },
                        { id: "generation", label: "Generation" },
                        { id: "error", label: "Error" },
                    ],
                    id: "providers",
                    rows: records.map((record) =>
                        agentWebProviderRow(record, defaultProvider),
                    ),
                    title: "Providers",
                },
            ],
        };
    };
}

function agentWebProviderRow(
    record: AgentProviderManagementRecord,
    defaultProvider: string | undefined,
): WebPageRow {
    return {
        cells: {
            default: {
                text: defaultProvider === record.id ? "yes" : "—",
                ...(defaultProvider === record.id
                    ? { tone: "success" as const }
                    : {}),
            },
            error: {
                text: record.error ?? "—",
                ...(record.error === undefined
                    ? {}
                    : { tone: "danger" as const }),
            },
            generation: {
                text: record.selectedGeneration ?? "—",
            },
            provider: { text: record.name ?? record.id },
            state: {
                text: record.state,
                tone:
                    record.state === "ready"
                        ? "success"
                        : record.state === "invalid"
                          ? "danger"
                          : record.state === "unselected"
                            ? "warning"
                            : "normal",
            },
            version: { text: record.version ?? "—" },
        },
        id: record.id,
    };
}

function createAgentTuiPage(providers: AgentProviderManager): TuiPageBinding {
    return async (request, invocation) => {
        invocation.signal.throwIfAborted();
        if (request.kind === "action") {
            if (!invocation.localOwner) {
                throw new Error(
                    "Agent provider mutations require the local Control owner.",
                );
            }
            if (request.itemId === undefined)
                throw new TypeError("Agent TUI action requires a provider id.");
            await applyAgentProviderAction(
                providers,
                request.actionId,
                request.itemId,
            );
        }
        const [records, defaultProvider] = await Promise.all([
            providers.list(),
            providers.getDefault(),
        ]);
        return {
            items: records.map((record) =>
                agentTuiProviderItem(record, defaultProvider),
            ),
        };
    };
}

function agentTuiProviderItem(
    record: AgentProviderManagementRecord,
    defaultProvider: string | undefined,
): TuiPageItem {
    const isDefault = defaultProvider === record.id;
    return {
        actions: [
            record.enabled
                ? { id: "disable", label: "Disable" }
                : { id: "enable", label: "Enable" },
            ...(record.enabled && record.state === "ready" && !isDefault
                ? [{ id: "default", label: "Set Default" }]
                : []),
            { id: "remove", label: "Remove", tone: "danger" },
        ],
        detail: [
            { text: `state ${record.state}` },
            { text: `enabled ${record.enabled ? "yes" : "no"}` },
            ...(record.version === undefined
                ? []
                : [{ text: `version ${record.version}` }]),
            ...(record.selectedGeneration === undefined
                ? []
                : [{ text: `generation ${record.selectedGeneration}` }]),
            ...(record.lastKnownGoodGeneration === undefined
                ? []
                : [{ text: `known-good ${record.lastKnownGoodGeneration}` }]),
            ...(isDefault ? [{ text: "default yes", tone: "success" as const }] : []),
            ...(record.error === undefined
                ? []
                : [{ text: `error ${record.error}`, tone: "danger" as const }]),
        ],
        id: record.id,
        status:
            record.state === "ready"
                ? "ready"
                : record.state === "invalid"
                  ? "failed"
                  : record.state === "unselected"
                    ? "warning"
                    : "disabled",
        summary: [
            {
                text: `${record.name ?? record.id} · ${record.version ?? "unknown"} · ${record.state}`,
            },
        ],
        title: record.id,
    };
}

async function applyAgentProviderAction(
    providers: AgentProviderManager,
    actionId: string,
    providerId: string,
): Promise<void> {
    if (actionId === "enable") await providers.enable(providerId);
    else if (actionId === "disable") await providers.disable(providerId);
    else if (actionId === "default") await providers.setDefault(providerId);
    else if (actionId === "remove") await providers.remove(providerId);
    else throw new TypeError(`Unknown Agent provider action: ${actionId}`);
}

export async function deactivate(): Promise<void> {
    const runtime = activeRuntime;
    activeRuntime = undefined;
    await runtime?.dispose();
}

async function findBundledProviders(
    context: ExtensionContext,
): Promise<Readonly<Record<string, string>>> {
    const root = join(context.paths.codeDirectory, "bundled-providers");
    const entries = await readdir(root, { withFileTypes: true }).catch(
        (error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        },
    );
    if (entries === undefined) return {};
    const providers: Record<string, string> = {};
    for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            !entry.name.endsWith(".dsprovider")
        ) {
            throw new TypeError(
                `Bundled Agent provider ${entry.name} must be a plain .dsprovider file.`,
            );
        }
        const id = entry.name.slice(0, -".dsprovider".length);
        if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
            throw new TypeError(`Invalid bundled Agent provider id: ${id}`);
        }
        const bundle = join(root, entry.name);
        const metadata = await lstat(bundle);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new TypeError(
                `Bundled Agent provider ${entry.name} must be a plain .dsprovider file.`,
            );
        }
        providers[id] = bundle;
    }
    return Object.freeze(providers);
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
