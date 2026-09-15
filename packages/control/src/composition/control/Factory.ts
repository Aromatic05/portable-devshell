import { homedir } from "node:os";

import { ControlPathHome } from "@portable-devshell/shared";
import { ExtensionHost } from "../../control/extension/Host.js";
import { ConversationPreferenceStore } from "../../control/config/preference/Store.js";
import { ExtensionArtifactCapabilityControl } from "../../control/extension/generation/capability/Resource.js";
import { ExtensionAssetCapabilityControl } from "../../control/extension/generation/capability/Resource.js";
import { ExtensionInstanceCapabilityControl } from "../../control/extension/generation/capability/Instance.js";
import {
    readBuiltinExtensionSources,
    type BuiltinExtensionSource,
} from "../../control/extension/install/BuiltinSource.js";
import type { ExtensionInstallLimits } from "../../control/extension/install/Policy.js";
import { ExtensionLoader } from "../../control/extension/generation/discovery/Loader.js";
import { ExtensionPathLayout } from "../../control/extension/state/Layout.js";
import { ExtensionRegistryStore } from "../../control/extension/state/Store.js";
import { createControlExtensionPointRegistry } from "../Extension.js";
import { McpRuntimeFactory } from "../mcp/Runtime.js";
import { ControlRuntimeArtifact } from "./subsystem/Artifact.js";
import { ControlRuntime } from "./Runtime.js";
import type { ControlRuntimeState } from "./State.js";
import { ControlRuntimeMcp } from "./subsystem/Mcp.js";
import { ControlRuntimeReverse } from "./subsystem/Reverse.js";
import { RuntimeSubscriptionManager } from "../../instance/execution/runtime/Subscription.js";

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
        const artifact = new ControlRuntimeArtifact({
            config: () => options.state.requireConfig(),
            controlPaths,
            homeDirectory: options.state.homeDirectory,
            instances: options.state.instances,
        });
        await artifact.start();
        try {
            const extensionPaths = new ExtensionPathLayout({
                homeDirectory: options.state.homeDirectory,
            });
            const extensionPoints = createControlExtensionPointRegistry();
            const runtimeSubscriptions = new RuntimeSubscriptionManager();
            const mcp = new ControlRuntimeMcp({
                artifact,
                controlPaths,
                factory: this.#mcpFactory,
                state: options.state,
            });
            const extensions = new ExtensionHost({
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
                    instanceFactory: ({ allowed, extensionId }) =>
                        new ExtensionInstanceCapabilityControl({
                            allowed,
                            create: mcp.instanceCreate,
                            editor: mcp.configEditor,
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
                            subscriptions: runtimeSubscriptions,
                        }),
                    instances: options.state.instances,
                    paths: extensionPaths,
                    points: extensionPoints,
                }),
                registry: new ExtensionRegistryStore(
                    extensionPaths.registryFile,
                ),
            });
            const reverse = new ControlRuntimeReverse({
                mcp,
                state: options.state,
            });
            mcp.configEditor.registerInstanceDeleteRetirement(
                async (instance) => {
                    await artifact.service.retireInstance(instance.name);
                },
            );
            return new ControlRuntime({
                artifact,
                builtinExtensionSources: this.#builtinExtensionSources,
                conversationPreferences: new ConversationPreferenceStore(
                    controlPaths.conversationPreferencesFile,
                ),
                extensionPaths,
                extensions,
                instances: options.state.instances,
                mcp,
                restart: options.restart,
                reverse,
                runtimeSubscriptions,
                shutdown: options.shutdown,
                socketPath: options.socketPath,
            });
        } catch (error) {
            await artifact.stop().catch(() => undefined);
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
