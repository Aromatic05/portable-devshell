import { homedir } from "node:os";

import { ControlPathHome } from "@portable-devshell/shared";
import { McpRuntimeFactory } from "../McpRuntimeFactory.js";
import { ArtifactRuntime } from "./ArtifactRuntime.js";
import { ControlRuntime } from "./ControlRuntime.js";
import type { ControlState } from "./ControlState.js";
import { McpRuntime } from "./McpRuntime.js";
import { ReverseRuntime } from "./ReverseRuntime.js";

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
        state: ControlState;
    }): Promise<ControlRuntime> {
        const controlPaths = new ControlPathHome(options.state.homeDirectory ?? homedir());
        const artifact = new ArtifactRuntime({
            config: () => options.state.requireConfig(),
            controlPaths,
            homeDirectory: options.state.homeDirectory,
            instances: options.state.instances
        });
        await artifact.start();
        try {
            const mcp = new McpRuntime({
                artifact,
                controlPaths,
                factory: this.#mcpFactory,
                state: options.state
            });
            const reverse = new ReverseRuntime({ mcp, state: options.state });
            return new ControlRuntime({
                artifact,
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
