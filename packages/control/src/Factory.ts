import { homedir } from "node:os";
import { join } from "node:path";

import {
    ControlPathHome,
    Endpoint,
    connectControlChannel,
    controlErrorCodes,
    createContextTransport,
    createEnvironmentTransport,
    createInstanceRuntimeTransport,
    createProcessTransport,
    createRemoteError,
    createServerTransport,
    createToolTransport,
} from "@portable-devshell/shared";
import { ReverseConnections } from "@portable-devshell/core";
import { createExtensionRuntime } from "./extension/index.js";
import { ExtensionArtifactCapabilityControl } from "./extension/api/cap/artifact/index.js";
import { ExtensionAssetCapabilityControl } from "./extension/api/cap/asset/index.js";
import {
    ExtensionInstanceManageCapabilityControl,
    ExtensionInstanceObserveCapabilityControl,
} from "./extension/api/cap/instance/index.js";
import { ExtensionContextObserveCapabilityControl } from "./extension/api/cap/context/index.js";
import {
    readBuiltinExtensionSources,
    type BuiltinExtensionSource,
} from "./extension/install/BuiltinSource.js";
import type { ExtensionInstallLimits } from "./extension/install/Policy.js";
import { ExtensionConfigControl } from "./extension/api/cap/config/index.js";
import { McpRuntimeFactory } from "./server/mcp/Runtime.js";
import { createArtifactRuntime } from "./artifact/index.js";
import { ControlServer } from "./server/index.js";
import { ControlState } from "./State.js";
import type { ControlConfig } from "./config/index.js";
import type { ControlInstances } from "./instance/index.js";
import { createToolCallRegistry } from "./toolcall/index.js";
import { createContextRuntime } from "./context/index.js";
import { McpControlModule } from "./server/mcp/Module.js";
import { ControlWebRuntime } from "./server/web/Runtime.js";
import { ConfigEditorCoordinator } from "./config/editor/index.js";
import { ConfigEngine } from "./config/engine/index.js";
import { HttpEndpointPreflight } from "./config/engine/Http.js";
import { InstanceEditorCoordinator } from "./instance/editor/index.js";
import { InstanceCreateCoordinator } from "./instance/editor/create/index.js";
import { createInstance } from "@portable-devshell/core";
import { ReverseCredentials } from "./instance/reverse/Credentials.js";
import { ReverseCredentialStore } from "./instance/reverse/credential/Store.js";
import { ReverseIngress } from "./server/reverse/Ingress.js";

export interface ControlFactoryOptions {
    builtinExtensionSources?: readonly BuiltinExtensionSource[];
    mcpFactory?: McpRuntimeFactory;
}

export class ControlFactory {
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #mcpFactory: McpRuntimeFactory;

    constructor(options: ControlFactoryOptions = {}) {
        this.#builtinExtensionSources = Object.freeze([
            ...(options.builtinExtensionSources ??
                readBuiltinExtensionSources()),
        ]);
        this.#mcpFactory = options.mcpFactory ?? new McpRuntimeFactory();
    }

    async create(options: {
        restart: () => Promise<void>;
        shutdown: () => Promise<void>;
        config: ControlConfig;
        homeDirectory?: string;
        instances: ControlInstances;
        socketPath: string;
    }): Promise<{ state: ControlState; server: ControlServer }> {
        const controlPaths = new ControlPathHome(
            options.homeDirectory ?? homedir(),
        );
        const toolRegistry = createToolCallRegistry();
        const artifact = createArtifactRuntime({
            config: () => options.config.require(),
            controlPaths,
            homeDirectory: options.homeDirectory,
            instances: options.instances.registry,
        });
        let composedState: ControlState | undefined;
        try {
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
                environment: (name) =>
                    createEnvironmentTransport(internalEndpoint, name),
                leaseInstance: (name) => {
                    const descriptor = options.instances.registry.get(name);
                    if (descriptor === undefined)
                        throw new Error(`Instance ${name} is unavailable.`);
                    return descriptor.lifecycle.acquireLease();
                },
                process: (name) =>
                    createProcessTransport(internalEndpoint, name),
                runtime: (name) =>
                    createInstanceRuntimeTransport(internalEndpoint, name),
            });
            const mcp = new McpControlModule({
                artifact,
                config: options.config.require(),
                contextTransport,
                controlPaths,
                factory: this.#mcpFactory,
                instances: options.instances.registry,
                toolRegistry,
            });
            let server: ControlServer | undefined;
            const configEngine = new ConfigEngine({
                configStore: options.config.store,
                getConfig: () => options.config.require(),
                getRestartControlRequired: () =>
                    options.config.restartRequired,
                homeDirectory: options.homeDirectory,
                markRestartControlRequired: () =>
                    options.config.markRestartRequired(),
                changeHub: options.config.changes,
                mutationRunner: options.config.mutations,
                registry: options.config.registry,
                runtimeApply: {
                    apply: async (previous, next, changes) =>
                        server === undefined
                            ? false
                            : await server.applyRuntimeConfig(
                                  previous,
                                  next,
                                  changes,
                              ),
                },
                runtimePreflight: new HttpEndpointPreflight(),
                setConfig: (config) => options.config.set(config),
            });
            const instanceEditor = new InstanceEditorCoordinator({
                createRuntimeInstance: (config) => createInstance(config),
                finalizeRuntimeInstance: (descriptor) => descriptor.close(),
                cleanupDebtFile: controlPaths.lifecycleCleanupFile,
                engine: configEngine,
                detachContextInstance: async (instance) => {
                    await contextTransport.detachInstance(instance);
                },
                reconcileContextInstanceCleanup: async (instance, target) =>
                    await contexts.api.cleanup.reconcileInstance(instance, target),
                instanceRegistry: options.instances.registry,
                instanceChanges: options.instances.changes,
                mcp: mcp.instancePort,
            });
            const instanceCreate = new InstanceCreateCoordinator({
                createRuntimeInstance: (config) => createInstance(config),
                engine: configEngine,
                finalizeRuntimeInstance: (descriptor) => descriptor.close(),
                assertCleanupSettled: async (instance) =>
                    await instanceEditor.assertInstanceCleanupSettled(instance),
                instanceChanges: options.instances.changes,
                instanceRegistry: options.instances.registry,
                mcp: mcp.instancePort,
            });
            const configEditor = new ConfigEditorCoordinator({
                engine: configEngine,
                instances: instanceEditor,
            });
            const extensions = createExtensionRuntime({
                configRegistry: options.config.registry,
                pathOptions: {
                    homeDirectory: options.homeDirectory,
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
                            const prepared =
                                await createEnvironmentTransport(
                                    internalEndpoint,
                                    input.target.instance,
                                ).prepareExtensionResource({
                                    collection: input.target.collection,
                                    extensionId,
                                });
                            const completed = await artifact.transferHostPath(
                                input.sourcePath,
                                {
                                    instance: input.target.instance,
                                    path: join(
                                        prepared.directory,
                                        input.target.key,
                                    ),
                                    workspace: prepared.directory,
                                },
                                input.overwrite,
                                input.signal,
                            );
                            return {
                                transferredBytes: completed.transferredBytes,
                            };
                        },
                    }),
                configFactory: ({
                    declaration,
                    extensionId,
                    generation,
                    stateDirectory,
                }) =>
                    new ExtensionConfigControl({
                        changeHub: options.config.changes,
                        declaration,
                        extensionId,
                        generation,
                        mutationRunner: options.config.mutations,
                        readCoreConfig: () => options.config.require(),
                        registry: options.config.registry,
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
                        process: (name) =>
                            createProcessTransport(internalEndpoint, name),
                    }),
                    observe: new ExtensionInstanceObserveCapabilityControl({
                        allowed: observeAllowed,
                        extensionId,
                        listConfigured: () =>
                            options.config
                                .require()
                                .instances.map((instance) => ({
                                    enabled: instance.enabled,
                                    mcpEnabled: instance.mcp.enabled,
                                    name: instance.name,
                                    provider: instance.provider,
                                })),
                        process: (name) =>
                            createProcessTransport(internalEndpoint, name),
                        runtime: (name) =>
                            createInstanceRuntimeTransport(internalEndpoint, name),
                    }),
                }),
                instanceRuntime: (name) =>
                    createInstanceRuntimeTransport(internalEndpoint, name),
                instances: options.instances.registry,
                readToolCalls: async (name, query) => {
                    const descriptor = options.instances.registry.get(name);
                    if (descriptor === undefined) throw new Error(`Instance ${name} is unavailable.`);
                    return await createToolTransport(
                        internalEndpoint,
                        name,
                    ).listCalls(query);
                },
                toolCallDecorator: mcp.toolProvenance,
            });
            const web = new ControlWebRuntime({
                config: options.config.require(),
                extensions,
                mcp,
                oauthDirectory: join(controlPaths.oauthDir, "web"),
            });
            const reverseConfig = options.config.require();
            const hasReverseInstance = reverseConfig.instances.some(
                (instance) => instance.provider === "reverse",
            );
            const reverseHost = mcp.host?.server;
            const reversePublicBaseUrl = reverseConfig.mcp.publicBaseUrl;
            let reverseConnections: ReverseConnections | undefined;
            let reverseCredentials: ReverseCredentials | undefined;
            let reverseIngress: ReverseIngress | undefined;
            if (reverseHost === undefined || reversePublicBaseUrl === undefined) {
                if (hasReverseInstance) {
                    throw createRemoteError({
                        code: controlErrorCodes.configValidationFailed,
                        message:
                            "Reverse instances require enabled MCP HTTP host and mcp.publicBaseUrl.",
                        retryable: false,
                    });
                }
            } else {
                const connections = new ReverseConnections({
                    instances: options.instances.registry,
                });
                reverseConnections = connections;
                reverseCredentials = new ReverseCredentials({
                    credentialStore: new ReverseCredentialStore(
                        options.homeDirectory,
                    ),
                    instanceRegistry: options.instances.registry,
                    publicBaseUrl: reversePublicBaseUrl,
                });
                reverseCredentials.setDisconnectHandler((instance) =>
                    connections.disconnect(instance),
                );
                reverseIngress = new ReverseIngress({
                    connections,
                    credentials: reverseCredentials,
                    publicBaseUrl: reversePublicBaseUrl,
                });
            }
            instanceEditor.registerInstanceDeleteRetirement(async (instance) => {
                if (instance.provider !== "reverse") return;
                await reverseCredentials?.retireInstance(instance.name);
            });
            instanceEditor.registerInstanceDisableRetirement(async (instance) => {
                if (instance.provider !== "reverse") return;
                await reverseCredentials?.retireInstance(instance.name);
            });
            instanceEditor.registerInstanceGenerationRetirement(
                async (instance) => {
                    await artifact.service.retireInstance(instance.name);
                },
            );
            const state = new ControlState({
                artifact,
                builtinExtensionSources: this.#builtinExtensionSources,
                config: () => options.config.require(),
                contexts,
                extensions,
                instanceChanges: options.instances.changes,
                instances: options.instances.registry,
                internalEndpoint,
                toolRegistry,
            });
            composedState = state;
            instanceEditor.registerInstanceGenerationRetirement(
                async (instance) => {
                    await state.extensions.retireInstanceGeneration(instance.name);
                },
            );
            const composedServer = new ControlServer({
                artifact: state.artifact,
                config: () => options.config.require(),
                configChanges: options.config.changes,
                configEditor,
                contexts: state.contexts,
                debug: state.debug,
                extensions: state.extensions,
                instanceCreate,
                instanceEditor,
                instanceChanges: options.instances.changes,
                instances: options.instances.registry,
                onConnectionDetached: (connectionId) =>
                    options.instances.connectionClosed(connectionId),
                internalControl: {
                    endpoint: internalEndpoint,
                    server: serverTransport,
                },
                mcp,
                restart: options.restart,
                reverse: {
                    credentials: reverseCredentials,
                    ingress: reverseIngress,
                },
                shutdown: options.shutdown,
                socketPath: options.socketPath,
                web,
            });
            instanceEditor.registerInstanceGenerationRetirement(
                async (instance) => {
                    await composedServer.retireInstanceGeneration(instance.name);
                },
            );
            options.instances.attachRuntime({
                editor: instanceEditor,
                ...(reverseConnections === undefined
                    ? {}
                    : { reverseConnections }),
            });
            server = composedServer;
            return { server: composedServer, state };
        } catch (error) {
            try {
                if (composedState === undefined) await artifact.stop();
                else await composedState.close();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Control composition failed and cleanup was incomplete.",
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
