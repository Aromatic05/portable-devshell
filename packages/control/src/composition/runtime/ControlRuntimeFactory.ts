import { homedir } from "node:os";

import { ControlPathHome } from "@portable-devshell/shared";
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
            const mcp = new ControlRuntimeMcp({
                artifact,
                controlPaths,
                factory: this.#mcpFactory,
                state: options.state
            });
            const reverse = new ControlRuntimeReverse({ mcp, state: options.state });
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
