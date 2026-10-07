import type { ControlConfig as ControlConfigDocument } from "@portable-devshell/shared";
import type { ControlConfigStore } from "../config/store/index.js";
import { ControlConfig } from "../config/index.js";
import { ControlInstances } from "../instance/index.js";
import { ControlState } from "../State.js";
import type { McpRuntimeFactory } from "./mcp/Runtime.js";
import { ControlRuntimeFactory } from "./runtime/Factory.js";
import type { ControlRuntime } from "./runtime/Runtime.js";
import { ControlSocketFile } from "@portable-devshell/shared";

export interface ControlServerOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    mcpWiringService?: McpRuntimeFactory;
    runtimeFactory?: ControlRuntimeFactory;
    startupDiagnostic?: (message: string) => void;
    xdgRuntimeDir?: string;
}

export class ControlServer {
    readonly #runtimeFactory: ControlRuntimeFactory;
    readonly #socketFile: ControlSocketFile;
    readonly #startupDiagnostic: (message: string) => void;
    readonly #config: ControlConfig;
    readonly #instances = new ControlInstances();
    readonly #state = new ControlState();
    readonly #homeDirectory?: string;
    #operationTail: Promise<void> = Promise.resolve();
    #runtime?: ControlRuntime;

    constructor(options: ControlServerOptions = {}) {
        this.#config = new ControlConfig({ store: options.configStore });
        this.#homeDirectory = options.homeDirectory;
        this.#runtimeFactory =
            options.runtimeFactory ??
            new ControlRuntimeFactory({
                mcpFactory: options.mcpWiringService,
            });
        this.#socketFile = new ControlSocketFile(options.xdgRuntimeDir);
        this.#startupDiagnostic =
            options.startupDiagnostic ?? (() => undefined);
    }

    get socketPath(): string {
        return this.#socketFile.path;
    }

    get config(): ControlConfigDocument | undefined {
        return this.#config.document;
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
        await this.#instances.close();
        this.#startupDiagnostic("control config load started");
        const config = await this.#config.load(this.#homeDirectory);
        this.#startupDiagnostic("control instances load started");
        await this.#instances.load(config);
        try {
            this.#startupDiagnostic("control composition input load completed");
            this.#startupDiagnostic(
                "control runtime directory initialization started",
            );
            await this.#socketFile.ensureRuntimeDir();
            this.#startupDiagnostic(
                "control runtime directory initialization completed",
            );
            this.#startupDiagnostic("control runtime composition started");
            const runtime = await this.#runtimeFactory.create({
                restart: async () => {
                    await this.restart();
                },
                shutdown: async () => {
                    await this.stop();
                },
                config: this.#config,
                homeDirectory: this.#homeDirectory,
                instances: this.#instances,
                socketPath: this.#socketFile.path,
                state: this.#state,
            });
            this.#startupDiagnostic("control runtime composition completed");
            this.#startupDiagnostic("control runtime start started");
            await runtime.start();
            this.#runtime = runtime;
            this.#startupDiagnostic("control runtime start completed");
        } catch (error) {
            try {
                await this.#instances.close();
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "Control startup failed and instance cleanup was incomplete.");
            }
            this.#instances.reset();
            this.#config.reset();
            throw error;
        }
    }

    async #stop(): Promise<void> {
        const runtime = this.#runtime;
        if (runtime !== undefined) await runtime.stop();
        await this.#instances.close();
        this.#runtime = undefined;
        this.#instances.reset();
        this.#config.reset();
    }

    async #runExclusive<T>(factory: () => Promise<T>): Promise<T> {
        const operation = this.#operationTail.then(factory, factory);
        this.#operationTail = operation.then(
            () => undefined,
            () => undefined,
        );
        return await operation;
    }
}
