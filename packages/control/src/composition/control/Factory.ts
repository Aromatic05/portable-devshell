import { homedir } from "node:os";

import { ControlPathHome } from "@portable-devshell/shared";
import { ExtensionHost } from "../../extension/host/Host.js";
import { ExtensionArtifactCapabilityControl } from "../../extension/api/cap/artifact/Control.js";
import { ExtensionAssetCapabilityControl } from "../../extension/api/cap/asset/Control.js";
import {
    ExtensionInstanceManageCapabilityControl,
    ExtensionInstanceObserveCapabilityControl,
} from "../../extension/api/cap/instance/Control.js";
import { ExtensionContextObserveCapabilityControl } from "../../extension/api/cap/context/Control.js";
import { ExtensionWorkerCapabilityControl } from "../../extension/api/cap/worker/Control.js";
import {
    readBuiltinExtensionSources,
    type BuiltinExtensionSource,
} from "../../extension/install/BuiltinSource.js";
import type { ExtensionInstallLimits } from "../../extension/install/Policy.js";
import { ExtensionLoader } from "../../extension/discovery/Loader.js";
import { ExtensionPathLayout } from "../../extension/state/Layout.js";
import { ExtensionRegistryStore } from "../../extension/state/Store.js";
import { ExtensionConfigControl } from "../../extension/api/cap/config/Control.js";
import { createControlExtensionPointRegistry } from "../Extension.js";
import { McpRuntimeFactory } from "../mcp/Runtime.js";
import { ArtifactModule } from "../../artifact/Module.js";
import { ControlRuntime } from "./Runtime.js";
import type { ControlRuntimeState } from "./State.js";
import { ContextModule } from "../../context/Module.js";
import { McpControlModule } from "../mcp/Control.js";
import { ConnectionModule } from "../../connection/Module.js";
import { ProcessSubscriptionManager } from "@portable-devshell/core";

export interface ControlRuntimeFactoryOptions {
    builtinExtensionSources?: readonly BuiltinExtensionSource[];
    mcpFactory?: McpRuntimeFactory;
}

export class ControlRuntimeFactory {
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #mcpFactory: McpRuntimeFactory;

    constructor(options: ControlRuntimeFactoryOptions = {}) {
        this.#builtinExtensionSources = Object.freeze([
            ...(options.builtinExtensionSources ??
                readBuiltinExtensionSources()),
        ]);
        this.#mcpFactory = options.mcpFactory ?? new McpRuntimeFactory();
    }

    async create(options: {
        restart: () => Promise<void>;
        shutdown: () => Promise<void>;
        socketPath: string;
        state: ControlRuntimeState;
    }): Promise<ControlRuntime> {
        const controlPaths = new ControlPathHome(
            options.state.homeDirectory ?? homedir(),
        );
        const artifact = new ArtifactModule({
            config: () => options.state.requireConfig(),
            controlPaths,
            homeDirectory: options.state.homeDirectory,
            instances: options.state.instances,
        });
        try {
            await artifact.start();
            const extensionPaths = new ExtensionPathLayout({
                homeDirectory: options.state.homeDirectory,
            });
            const extensionPoints = createControlExtensionPointRegistry();
            const processSubscriptions = new ProcessSubscriptionManager();
            const contexts = new ContextModule({
                contextFile: controlPaths.contextsFile,
                instances: options.state.instances,
            });
            const mcp = new McpControlModule({
                contexts,
                artifact,
                controlPaths,
                factory: this.#mcpFactory,
                state: options.state,
            });
            const extensions = new ExtensionHost({
                configRegistry: options.state.configRegistry,
                loader: new ExtensionLoader({
                    artifactFactory: ({ allowed, extensionId }) =>
                        new ExtensionArtifactCapabilityControl({
                            allowed,
                            extensionId,
                            service: artifact.service,
                        }),
                    assetsFactory: ({ allowed, dataDirectory, extensionId }) =>
                        new ExtensionAssetCapabilityControl({
                            allowed,
                            dataDirectory,
                            extensionId,
                            limits: resolveControlExtensionAssetLimits(
                                extensionId,
                            ),
                            project: async (input) =>
                                await artifact.projectExtensionAsset(
                                    extensionId,
                                    input,
                                ),
                        }),
                    configFactory: ({
                        declaration,
                        extensionId,
                        generation,
                        stateDirectory,
                    }) =>
                        new ExtensionConfigControl({
                            changeHub: options.state.configChanges,
                            declaration,
                            extensionId,
                            generation,
                            mutationRunner: options.state.configMutations,
                            readCoreConfig: () => options.state.requireConfig(),
                            registry: options.state.configRegistry,
                            stateDirectory,
                            updateCoreConfig: async (patch) =>
                                await mcp.configEditor.updateCorePaths(patch),
                        }),
                    contextObserveFactory: ({ allowed, extensionId }) =>
                        new ExtensionContextObserveCapabilityControl({
                            allowed,
                            extensionId,
                            listContexts: async (query) =>
                                await contexts.registry.list(query),
                        }),
                    instanceFactory: ({
                        extensionId,
                        manageAllowed,
                        observeAllowed,
                    }) => ({
                        manage: new ExtensionInstanceManageCapabilityControl({
                            allowed: manageAllowed,
                            create: mcp.instanceCreate,
                            editor: mcp.instanceEditor,
                            extensionId,
                            instances: options.state.instances,
                        }),
                        observe: new ExtensionInstanceObserveCapabilityControl({
                            allowed: observeAllowed,
                            extensionId,
                            instances: options.state.instances,
                            listConfigured: () =>
                                options.state
                                    .requireConfig()
                                    .instances.map((instance) => ({
                                        enabled: instance.enabled,
                                        mcpEnabled: instance.mcp.enabled,
                                        name: instance.name,
                                        provider: instance.provider,
                                    })),
                            subscriptions: processSubscriptions,
                        }),
                    }),
                    instances: options.state.instances,
                    paths: extensionPaths,
                    points: extensionPoints,
                    toolCallDecorator: mcp.toolProvenance,
                    workerDelegateFactory: (input) =>
                        new ExtensionWorkerCapabilityControl({
                            ...input,
                            authority: "worker.delegate",
                            instances: options.state.instances,
                            toolCalls: mcp.instanceGateway,
                        }),
                    workerExecuteFactory: (input) =>
                        new ExtensionWorkerCapabilityControl({
                            ...input,
                            authority: "worker.execute",
                            instances: options.state.instances,
                            toolCalls: mcp.instanceGateway,
                        }),
                }),
                registry: new ExtensionRegistryStore(
                    extensionPaths.registryFile,
                ),
            });
            const reverse = new ConnectionModule({
                mcp,
                state: options.state,
            });
            mcp.instanceEditor.registerInstanceGenerationRetirement(
                async (instance) => {
                    await artifact.service.retireInstance(instance.name);
                },
            );
            return new ControlRuntime({
                contexts,
                artifact,
                builtinExtensionSources: this.#builtinExtensionSources,
                config: () => options.state.requireConfig(),
                configChanges: options.state.configChanges,
                extensionPaths,
                extensions,
                instances: options.state.instances,
                mcp,
                restart: options.restart,
                reverse,
                processSubscriptions,
                shutdown: options.shutdown,
                socketPath: options.socketPath,
            });
        } catch (error) {
            try {
                await artifact.stop();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Control runtime composition failed and Artifact rollback was incomplete.",
                );
            }
            throw error;
        }
    }
}

export function resolveControlExtensionAssetLimits(
    extensionId: string,
): Partial<ExtensionInstallLimits> | undefined {
    if (extensionId !== "agent") return undefined;
    return {
        maxCompressedBytes: 128 * 1024 * 1024,
        maxFileBytes: 256 * 1024 * 1024,
        maxLogicalBytes: 512 * 1024 * 1024,
    };
}
