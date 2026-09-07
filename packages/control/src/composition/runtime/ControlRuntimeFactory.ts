import { homedir } from "node:os";

import { ControlPathHome } from "@portable-devshell/shared";
import { ExtensionHost } from "../../control/extension/ExtensionHost.js";
import { ExtensionLoader } from "../../control/extension/ExtensionLoader.js";
import { ExtensionPathLayout } from "../../control/extension/ExtensionPathLayout.js";
import { ExtensionRegistryStore } from "../../control/extension/ExtensionRegistryStore.js";
import { McpRuntimeFactory } from "../McpRuntimeFactory.js";
import { ControlRuntimeArtifact } from "./ControlRuntimeArtifact.js";
import { ControlRuntime } from "./ControlRuntime.js";
import type { ControlRuntimeState } from "./ControlRuntimeState.js";
import { ControlRuntimeMcp } from "./ControlRuntimeMcp.js";
import { ControlRuntimeReverse } from "./ControlRuntimeReverse.js";

export interface ControlRuntimeFactoryOptions {
    mcpFactory?: McpRuntimeFactory;
}

export class ControlRuntimeFactory {
    readonly #mcpFactory: McpRuntimeFactory;

    constructor(options: ControlRuntimeFactoryOptions = {}) {
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
            const extensions = new ExtensionHost({
                loader: new ExtensionLoader({
                    instances: options.state.instances,
                    paths: extensionPaths
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
