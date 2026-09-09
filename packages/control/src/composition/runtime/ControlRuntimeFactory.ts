import { homedir } from "node:os";

import { ControlPathHome } from "@portable-devshell/shared";
import { ExtensionHost } from "../../control/extension/host/ExtensionHost.js";
import { ExtensionAssetCapabilityControl } from "../../control/extension/host/generation/capability/ExtensionAssetCapabilityControl.js";
import { readBuiltinExtensionSources, type BuiltinExtensionSource } from "../../control/extension/install/ExtensionBuiltinSource.js";
import { ExtensionLoader } from "../../control/extension/host/generation/ExtensionLoader.js";
import { ExtensionPathLayout } from "../../control/extension/state/ExtensionPathLayout.js";
import { ExtensionRegistryStore } from "../../control/extension/state/ExtensionRegistryStore.js";
import { createControlExtensionPointRegistry } from "../ControlExtensionPointRegistry.js";
import { McpRuntimeFactory } from "../McpRuntimeFactory.js";
import { ControlRuntimeArtifact } from "./ControlRuntimeArtifact.js";
import { ControlRuntime } from "./ControlRuntime.js";
import type { ControlRuntimeState } from "./ControlRuntimeState.js";
import { ControlRuntimeMcp } from "./ControlRuntimeMcp.js";
import { ControlRuntimeReverse } from "./ControlRuntimeReverse.js";

export interface ControlRuntimeFactoryOptions {
    builtinExtensionSources?: readonly BuiltinExtensionSource[];
    mcpFactory?: McpRuntimeFactory;
}

export class ControlRuntimeFactory {
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #mcpFactory: McpRuntimeFactory;

    constructor(options: ControlRuntimeFactoryOptions = {}) {
        this.#builtinExtensionSources = Object.freeze([
            ...(options.builtinExtensionSources ?? readBuiltinExtensionSources())
        ]);
        this.#mcpFactory = options.mcpFactory ?? new McpRuntimeFactory();
    }

    async create(options: {
        restart: () => Promise<void>;
        shutdown: () => Promise<void>;
        socketPath: string;
        state: ControlRuntimeState;
    }): Promise<ControlRuntime> {
        const controlPaths = new ControlPathHome(options.state.homeDirectory ?? homedir());
        const artifact = new ControlRuntimeArtifact({
            config: () => options.state.requireConfig(),
            controlPaths,
            homeDirectory: options.state.homeDirectory,
            instances: options.state.instances
        });
        await artifact.start();
        try {
            const extensionPaths = new ExtensionPathLayout({ homeDirectory: options.state.homeDirectory });
            const extensionPoints = createControlExtensionPointRegistry();
            const extensions = new ExtensionHost({
                loader: new ExtensionLoader({
                    assetsFactory: ({ allowed, dataDirectory, extensionId }) => new ExtensionAssetCapabilityControl({
                        allowed,
                        dataDirectory,
                        extensionId,
                        project: async (input) => await artifact.projectExtensionAsset(extensionId, input)
                    }),
                    instances: options.state.instances,
                    paths: extensionPaths,
                    points: extensionPoints
                }),
                registry: new ExtensionRegistryStore(extensionPaths.registryFile)
            });
            const mcp = new ControlRuntimeMcp({
                artifact,
                controlPaths,
                factory: this.#mcpFactory,
                state: options.state
            });
            const reverse = new ControlRuntimeReverse({ mcp, state: options.state });
            mcp.configEditor.registerInstanceDeleteRetirement(async (instance) => {
                await artifact.service.retireInstance(instance.name);
            });
            return new ControlRuntime({
                artifact,
                builtinExtensionSources: this.#builtinExtensionSources,
                extensionPaths,
                extensions,
                instances: options.state.instances,
                mcp,
                restart: options.restart,
                reverse,
                shutdown: options.shutdown,
                socketPath: options.socketPath
            });
        } catch (error) {
            await artifact.stop().catch(() => undefined);
            throw error;
        }
    }
}
