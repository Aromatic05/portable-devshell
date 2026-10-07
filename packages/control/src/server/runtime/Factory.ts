import { homedir } from "node:os";
import { join } from "node:path";

import {
    ControlPathHome,
    Endpoint,
    connectControlChannel,
    createContextTransport,
    createProcessTransport,
    createServerTransport,
    createToolTransport,
} from "@portable-devshell/shared";
import { createExtensionRuntime } from "../../extension/index.js";
import { ExtensionArtifactCapabilityControl } from "../../extension/api/cap/artifact/index.js";
import { ExtensionAssetCapabilityControl } from "../../extension/api/cap/asset/index.js";
import {
    ExtensionInstanceManageCapabilityControl,
    ExtensionInstanceObserveCapabilityControl,
} from "../../extension/api/cap/instance/index.js";
import { ExtensionContextObserveCapabilityControl } from "../../extension/api/cap/context/index.js";
import {
    readBuiltinExtensionSources,
    type BuiltinExtensionSource,
} from "../../extension/install/BuiltinSource.js";
import type { ExtensionInstallLimits } from "../../extension/install/Policy.js";
import { ExtensionConfigControl } from "../../extension/api/cap/config/index.js";
import { McpRuntimeFactory } from "../mcp/Runtime.js";
import { createArtifactRuntime } from "../../artifact/index.js";
import { ControlRuntime } from "./Runtime.js";
import type { ControlRuntimeState } from "./State.js";
import { createContextRuntime } from "../../context/index.js";
import { McpControlModule } from "../mcp/Module.js";
import { ControlWebRuntime } from "../web/Runtime.js";
import { ConfigEditorCoordinator } from "../../config/editor/index.js";
import { ConfigEngine } from "../../config/engine/index.js";
import { HttpEndpointPreflight } from "../../config/engine/Http.js";
import { InstanceEditorCoordinator } from "../../instance/editor/index.js";
import { InstanceCreateCoordinator } from "../../instance/editor/create/index.js";
import { createInstance } from "@portable-devshell/core";
import { ConnectionModule } from "../../reverse/index.js";
import { ProcessSubscriptionManager } from "@portable-devshell/shared";

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
        const artifact = createArtifactRuntime({
            config: () => options.state.requireConfig(),
            controlPaths,
            homeDirectory: options.state.homeDirectory,
            instances: options.state.instances,
        });
        try {
            await artifact.start();
            const processSubscriptions = new ProcessSubscriptionManager();
            const internalEndpoint = new Endpoint({
                connectChannel: (signal) =>
                    connectControlChannel(
                        { socketPath: options.socketPath },
                        signal,
                    ),
            });
            const contextTransport = createContextTransport(internalEndpoint);
            const serverTransport = createServerTransport(internalEndpoint, {
                clientKind: "cli",
            });
            const contexts = createContextRuntime({
                contextFile: controlPaths.contextsFile,
                instances: options.state.instances,
            });
            const mcp = new McpControlModule({
                artifact,
                config: options.state.requireConfig(),
                contextTransport,
                controlPaths,
                factory: this.#mcpFactory,
                instances: options.state.instances,
                toolRegistry: options.state.toolCalls,
            });
            const configEngine = new ConfigEngine({
                configStore: options.state.configStore,
                getConfig: () => options.state.requireConfig(),
                getRestartControlRequired: () =>
                    options.state.restartControlRequired,
                homeDirectory: options.state.homeDirectory,
                markRestartControlRequired: () =>
                    options.state.markRestartControlRequired(),
                changeHub: options.state.configChanges,
                mutationRunner: options.state.configMutations,
                registry: options.state.configRegistry,
                runtimeApply: {
                    apply: async (previous, next, changes) =>
                        await mcp.applyRuntimeConfig(previous, next, changes),
                },
                runtimePreflight: new HttpEndpointPreflight(),
                setConfig: (config) => options.state.setConfig(config),
            });
            const instanceEditor = new InstanceEditorCoordinator({
                createRuntimeInstance: (config) => createInstance(config),
                finalizeRuntimeInstance: (descriptor) => descriptor.close(),
                cleanupDebtFile: controlPaths.lifecycleCleanupFile,
                engine: configEngine,
                detachContextInstance: async (instance) => {
                    await contextTransport.detachInstance(instance);
                },
                reconcileContextInstanceCleanup: async (instance, descriptor) => {
                    if (
                        descriptor !== undefined &&
                        !descriptor.worker.supervision.snapshot().ready
                    ) {
                        await descriptor.worker.supervision.lifecycle.start();
                    }
                    await contexts.api.cleanup.reconcileInstance(
                        instance,
                        descriptor,
                    );
                },
                instanceRegistry: options.state.instances,
                instanceChanges: options.state.instanceChanges,
                mcp: mcp.instancePort,
            });
            const instanceCreate = new InstanceCreateCoordinator({
                publishConfigChange: (paths) => options.state.configChanges.publish(paths),
                createRuntimeInstance: (config) => createInstance(config),
                finalizeRuntimeInstance: (descriptor) => descriptor.close(),
                assertCleanupSettled: async (instance) =>
                    await instanceEditor.assertInstanceCleanupSettled(instance),
                configStore: options.state.configStore,
                getConfig: () => options.state.requireConfig(),
                homeDirectory: options.state.homeDirectory,
                instanceChanges: options.state.instanceChanges,
                instanceRegistry: options.state.instances,
                mcp: mcp.instancePort,
                mutationRunner: options.state.configMutations,
                setConfig: (config) => options.state.setConfig(config),
            });
            const configEditor = new ConfigEditorCoordinator({
                engine: configEngine,
                configStore: options.state.configStore,
                getConfig: () => options.state.requireConfig(),
                getRestartControlRequired: () =>
                    options.state.restartControlRequired,
                homeDirectory: options.state.homeDirectory,
                instances: instanceEditor,
                markRestartControlRequired: () =>
                    options.state.markRestartControlRequired(),
                changeHub: options.state.configChanges,
                mutationRunner: options.state.configMutations,
                registry: options.state.configRegistry,
                setConfig: (config) => options.state.setConfig(config),
            });
            const extensions = createExtensionRuntime({
                configRegistry: options.state.configRegistry,
                pathOptions: {
                    homeDirectory: options.state.homeDirectory,
                },
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
                        project: async (input) => {
                            const descriptor =
                                options.state.instances.get(
                                    input.target.instance,
                                );
                            if (descriptor === undefined)
                                throw new Error(
                                    `Instance ${input.target.instance} is unavailable.`,
                                );
                            const lease = descriptor.lifecycle.acquireLease();
                            try {
                                const prepared =
                                    await lease.instance.worker.execution.environment.prepareExtensionResource(
                                        {
                                            collection:
                                                input.target.collection,
                                            extensionId,
                                        },
                                    );
                                const completed =
                                    await artifact.transferHostPath(
                                        input.sourcePath,
                                        {
                                            instance:
                                                input.target.instance,
                                            path: join(
                                                prepared.directory,
                                                input.target.key,
                                            ),
                                            workspace:
                                                prepared.directory,
                                        },
                                        input.overwrite,
                                        input.signal,
                                    );
                                return {
                                    transferredBytes:
                                        completed.transferredBytes,
                                };
                            } finally {
                                lease.release();
                            }
                        },
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
                            await configEditor.updateCorePaths(patch),
                    }),
                contextObserveFactory: ({ allowed, extensionId }) =>
                    new ExtensionContextObserveCapabilityControl({
                        allowed,
                        extensionId,
                        listContexts: async (query) =>
                            await contextTransport.list(query),
                    }),
                instanceFactory: ({
                    extensionId,
                    manageAllowed,
                    observeAllowed,
                }) => ({
                    manage: new ExtensionInstanceManageCapabilityControl({
                        allowed: manageAllowed,
                        create: instanceCreate,
                        editor: instanceEditor,
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
                        readLogs: async (name, query) => {
                            const descriptor = options.state.instances.get(name);
                            if (descriptor === undefined) throw new Error(`Instance ${name} is unavailable.`);
                            return await createProcessTransport(
                                internalEndpoint,
                                name,
                            ).readLogs(query);
                        },
                    }),
                }),
                instances: options.state.instances,
                readToolCalls: async (name, query) => {
                    const descriptor = options.state.instances.get(name);
                    if (descriptor === undefined) throw new Error(`Instance ${name} is unavailable.`);
                    return await createToolTransport(
                        internalEndpoint,
                        name,
                    ).listCalls(query);
                },
                toolCallDecorator: mcp.toolProvenance,
            });
            const web = new ControlWebRuntime({
                config: options.state.requireConfig(),
                extensions,
                mcp,
                oauthDirectory: join(controlPaths.oauthDir, "web"),
            });
            const reverse = new ConnectionModule({
                hasReverseInstance: options.state
                    .requireConfig()
                    .instances.some((instance) => instance.provider === "reverse"),
                homeDirectory: options.state.homeDirectory,
                host: mcp.host?.server,
                instances: options.state.instances,
                publicBaseUrl: options.state.requireConfig().mcp.publicBaseUrl,
            });
            instanceEditor.registerInstanceDeleteRetirement(async (instance) => {
                if (instance.provider !== "reverse") return;
                await reverse.service?.retireInstance(instance.name);
            });
            instanceEditor.registerInstanceDisableRetirement(async (instance) => {
                if (instance.provider !== "reverse") return;
                await reverse.service?.retireInstance(instance.name);
            });
            instanceEditor.registerInstanceGenerationRetirement(
                async (instance) => {
                    await artifact.service.retireInstance(instance.name);
                },
            );
            return new ControlRuntime({
                contexts,
                contextTransport,
                internalControl: {
                    endpoint: internalEndpoint,
                    server: serverTransport,
                },
                artifact,
                builtinExtensionSources: this.#builtinExtensionSources,
                config: () => options.state.requireConfig(),
                configChanges: options.state.configChanges,
                configEditor,
                extensions,
                instanceCreate,
                instanceEditor,
                instanceChanges: options.state.instanceChanges,
                instances: options.state.instances,
                mcp,
                toolCalls: options.state.toolCalls,
                restart: options.restart,
                reverse,
                shutdown: options.shutdown,
                socketPath: options.socketPath,
                web,
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
