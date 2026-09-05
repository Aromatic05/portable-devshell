import type { ControlConfig } from "@portable-devshell/shared";
import type { ControlConfigStore } from "../control/config/ControlConfigStore.js";
import type { InstanceRegistryFactory } from "../control/instance/registry/InstanceRegistryFactory.js";
import type { McpRuntimeFactory } from "../composition/McpRuntimeFactory.js";
import { ControlRuntimeFactory } from "../composition/runtime/ControlRuntimeFactory.js";
import type { ControlRuntime } from "../composition/runtime/ControlRuntime.js";
import { ControlRuntimeState } from "../composition/runtime/ControlRuntimeState.js";
import { ControlSocketFile } from "@portable-devshell/shared";

export interface ControlServerOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    instanceRegistryBuilder?: InstanceRegistryFactory;
    mcpWiringService?: McpRuntimeFactory;
    runtimeFactory?: ControlRuntimeFactory;
    startupDiagnostic?: (message: string) => void;
    xdgRuntimeDir?: string;
}

export class ControlServer {
    readonly #runtimeFactory: ControlRuntimeFactory;
    readonly #socketFile: ControlSocketFile;
    readonly #startupDiagnostic: (message: string) => void;
    readonly #state: ControlRuntimeState;
    #operationTail: Promise<void> = Promise.resolve();
    #runtime?: ControlRuntime;

    constructor(options: ControlServerOptions = {}) {
        this.#state = new ControlRuntimeState({
            configStore: options.configStore,
            homeDirectory: options.homeDirectory,
            instanceRegistryFactory: options.instanceRegistryBuilder
        });
        this.#runtimeFactory = options.runtimeFactory ?? new ControlRuntimeFactory({
            mcpFactory: options.mcpWiringService
        });
        this.#socketFile = new ControlSocketFile(options.xdgRuntimeDir);
        this.#startupDiagnostic = options.startupDiagnostic ?? (() => undefined);
    }

    get socketPath(): string {
        return this.#socketFile.path;
    }

    get config(): ControlConfig | undefined {
        return this.#state.config;
    }

    async start(): Promise<void> {
        await this.#runExclusive(async () => await this.#start());
    }

    async stop(): Promise<void> {
        await this.#runExclusive(async () => await this.#stop());
    }

    async restart(): Promise<void> {
        await this.#runExclusive(async () => {
            await this.#stop();
            await this.#start();
        });
    }

    async #start(): Promise<void> {
        if (this.#runtime !== undefined) return;
        this.#startupDiagnostic("control state load started");
        await this.#state.load();
        this.#startupDiagnostic("control state load completed");
        this.#startupDiagnostic("control runtime directory initialization started");
        await this.#socketFile.ensureRuntimeDir();
        this.#startupDiagnostic("control runtime directory initialization completed");
        this.#startupDiagnostic("control runtime composition started");
        const runtime = await this.#runtimeFactory.create({
            restart: async () => {
                await this.restart();
            },
            shutdown: async () => {
                await this.stop();
            },
            socketPath: this.#socketFile.path,
            state: this.#state
        });
        this.#startupDiagnostic("control runtime composition completed");
        try {
            this.#startupDiagnostic("control runtime start started");
            await runtime.start();
            this.#runtime = runtime;
            this.#startupDiagnostic("control runtime start completed");
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

    async #runExclusive<T>(factory: () => Promise<T>): Promise<T> {
        const operation = this.#operationTail.then(factory, factory);
        this.#operationTail = operation.then(
            () => undefined,
            () => undefined
        );
        return await operation;
    }
}
