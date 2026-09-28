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
import {
    AgentProviderManager,
    type AgentProviderDefinition,
    type AgentProviderManagementRecord,
} from "./provider/AgentProviderManager.js";
import { AgentProviderPackageInstaller } from "./provider/AgentProviderPackageInstaller.js";
import { AgentProviderRegistry } from "./provider/AgentProviderRegistry.js";
import { AgentProviderRegistryStore } from "./provider/AgentProviderRegistryStore.js";
import { ensurePiCommand } from "./pi/PiCommandInstaller.js";
import {
    PI_PROVIDER_ID,
    PI_PROVIDER_VERSION,
    PiAgentProvider,
} from "../provider/pi/PiAgentProvider.js";
import {
    PI_PROVIDER_RUNTIME_DEPENDENCIES,
    hasManagedPiInstallation,
    removeManagedPiInstallation,
} from "../provider/pi/PiProviderInstaller.js";
import {
    OPENCODE_PROVIDER_ID,
    OPENCODE_PROVIDER_VERSION,
    OpenCodeAgentProvider,
} from "../provider/opencode/OpenCodeAgentProvider.js";
import { OPENCODE_PROVIDER_RUNTIME_DEPENDENCIES } from "../provider/opencode/OpenCodeProviderInstaller.js";

let activeRuntime: AgentExtensionRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
    if (activeRuntime !== undefined)
        throw new Error(
            "Agent Extension is already active in this generation.",
        );
    const providerStore = new AgentProviderRegistryStore(
        join(context.paths.stateDirectory, "providers.json"),
    );
    const processes = context.capabilities.processes;
    if (processes === undefined) {
        throw new Error("Agent Extension requires the processes capability.");
    }
    const packageInstaller = new AgentProviderPackageInstaller(processes);
    const definitions = createProviderDefinitions(context, packageInstaller);
    const providerRegistry = new AgentProviderRegistry();
    const providerManager: AgentProviderManager = new AgentProviderManager({
        definitions,
        isProviderInUse: (id) => runtime?.isProviderInUse(id) ?? false,
        registry: providerRegistry,
        runtimeRootDirectory: context.paths.stateDirectory,
        store: providerStore,
    });
    const runtime = new AgentExtensionRuntime(context, {
        registry: providerRegistry,
        resolveProvider: async (requested) =>
            await providerManager.resolveProvider(requested),
    });
    await providerManager.initialize();
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

function createProviderDefinitions(
    context: ExtensionContext,
    packages: AgentProviderPackageInstaller,
): readonly AgentProviderDefinition[] {
    const piPackage = {
        dependencies: PI_PROVIDER_RUNTIME_DEPENDENCIES,
        id: PI_PROVIDER_ID,
        version: PI_PROVIDER_VERSION,
    };
    const openCodePackage = {
        dependencies: OPENCODE_PROVIDER_RUNTIME_DEPENDENCIES,
        id: OPENCODE_PROVIDER_ID,
        version: OPENCODE_PROVIDER_VERSION,
    };
    return [
        {
            create: () => new PiAgentProvider(),
            id: PI_PROVIDER_ID,
            install: async (runtime, options) => {
                await packages.install(runtime, piPackage, options);
                const command = await ensurePiCommand(context);
                if (!command.installed) {
                    context.logger.warn(
                        command.reason === "collision"
                            ? "Pi Provider is installed, but " +
                                  command.command +
                                  " is owned by another installation and was not replaced."
                            : "Pi Provider is installed, but the packaged Pi launcher is missing; the pi command was not published.",
                    );
                }
            },
            isInstalled: async (runtime) =>
                (await packages.isInstalled(runtime, piPackage)) ||
                (await hasManagedPiInstallation(runtime)),
            name: "Pi",
            remove: async (runtime) => {
                await packages.remove(runtime);
                await removeManagedPiInstallation(runtime);
            },
            version: PI_PROVIDER_VERSION,
        },
        {
            create: () => new OpenCodeAgentProvider(),
            id: OPENCODE_PROVIDER_ID,
            install: async (runtime, options) =>
                await packages.install(runtime, openCodePackage, options),
            isInstalled: async (runtime) =>
                await packages.isInstalled(runtime, openCodePackage),
            name: "OpenCode",
            remove: async (runtime) => await packages.remove(runtime),
            version: OPENCODE_PROVIDER_VERSION,
        },
    ];
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
                        { id: "installed", label: "Installed" },
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
            installed: {
                text: record.installedVersion ?? "—",
            },
            provider: { text: record.name ?? record.id },
            state: {
                text: record.state,
                tone:
                    record.state === "ready"
                        ? "success"
                        : record.state === "invalid"
                          ? "danger"
                          : record.state === "uninstalled"
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
            ...(record.state === "uninstalled"
                ? [{ id: "install", label: "Install" }]
                : [
                      record.enabled
                          ? { id: "disable", label: "Disable" }
                          : { id: "enable", label: "Enable" },
                      { id: "update", label: "Update" },
                  ]),
            ...(record.enabled && record.state === "ready" && !isDefault
                ? [{ id: "default", label: "Set Default" }]
                : []),
            ...(record.state === "uninstalled"
                ? []
                : [{ id: "remove", label: "Remove", tone: "danger" as const }]),
        ],
        detail: [
            { text: `state ${record.state}` },
            { text: `enabled ${record.enabled ? "yes" : "no"}` },
            ...(record.version === undefined
                ? []
                : [{ text: `version ${record.version}` }]),
            ...(record.installedVersion === undefined
                ? []
                : [{ text: `installed ${record.installedVersion}` }]),
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
                  : record.state === "uninstalled"
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
    if (actionId === "install") await providers.install(providerId);
    else if (actionId === "update") await providers.update(providerId);
    else if (actionId === "enable") await providers.enable(providerId);
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
