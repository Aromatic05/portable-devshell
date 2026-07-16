import type { ControlConfig } from "../modules/config/config/codec/ConfigTomlCodec.js";
import type { ControlConfigStore } from "../modules/config/config/ControlConfigStore.js";
import type { InstanceRegistryFactory } from "../composition/InstanceRegistryFactory.js";
import type { McpRuntimeFactory } from "../composition/McpRuntimeFactory.js";
import { ControlRuntimeFactory } from "../composition/runtime/ControlRuntimeFactory.js";
import type { ControlRuntime } from "../composition/runtime/ControlRuntime.js";
import { ControlState } from "../composition/runtime/ControlState.js";
import { ControlSocketFile } from "@portable-devshell/shared";

export interface ControlServerOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    instanceRegistryBuilder?: InstanceRegistryFactory;
    mcpWiringService?: McpRuntimeFactory;
    runtimeFactory?: ControlRuntimeFactory;
    xdgRuntimeDir?: string;
}

export class ControlServer {
    readonly #runtimeFactory: ControlRuntimeFactory;
    readonly #socketFile: ControlSocketFile;
    readonly #state: ControlState;
    #runtime?: ControlRuntime;
    #startPromise?: Promise<void>;
    #stopPromise?: Promise<void>;

    constructor(options: ControlServerOptions = {}) {
        this.#state = new ControlState({
            configStore: options.configStore,
            homeDirectory: options.homeDirectory,
            instanceRegistryFactory: options.instanceRegistryBuilder
        });
        this.#runtimeFactory = options.runtimeFactory ?? new ControlRuntimeFactory({
            mcpFactory: options.mcpWiringService
        });
        this.#socketFile = new ControlSocketFile(options.xdgRuntimeDir);
    }

    get socketPath(): string {
        return this.#socketFile.path;
    }

    get config(): ControlConfig | undefined {
        return this.#state.config;
    }

    async start(): Promise<void> {
        if (this.#runtime !== undefined) return;
        if (this.#startPromise !== undefined) return await this.#startPromise;
        this.#startPromise = this.#start();
        try {
            await this.#startPromise;
        } finally {
            this.#startPromise = undefined;
        }
    }

    async stop(): Promise<void> {
        if (this.#stopPromise !== undefined) return await this.#stopPromise;
        this.#stopPromise = this.#stop();
        try {
            await this.#stopPromise;
        } finally {
            this.#stopPromise = undefined;
        }
    }

    async #start(): Promise<void> {
        await this.#state.load();
        await this.#socketFile.ensureRuntimeDir();
        const runtime = await this.#runtimeFactory.create({
            restart: async () => {
                await this.stop();
                await this.start();
            },
            shutdown: async () => {
                await this.stop();
            },
            socketPath: this.#socketFile.path,
            state: this.#state
        });
        try {
            await runtime.start();
            this.#runtime = runtime;
        } catch (error) {
            this.#state.reset();
            throw error;
        }
    }

    async #stop(): Promise<void> {
        const runtime = this.#runtime;
        this.#runtime = undefined;
        try {
            await runtime?.stop();
        } finally {
            this.#state.reset();
        }
    }
}
