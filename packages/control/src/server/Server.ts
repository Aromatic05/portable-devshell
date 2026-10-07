import type { ControlConfig as ControlConfigDocument } from "@portable-devshell/shared";
import { ControlSocketFile } from "@portable-devshell/shared";

import type { ControlState } from "../State.js";
import { ControlConfig } from "../config/index.js";
import type { ControlConfigStore } from "../config/store/index.js";
import { ControlInstances } from "../instance/index.js";
import type { McpRuntimeFactory } from "./mcp/Runtime.js";
import { ControlRuntimeFactory } from "./runtime/Factory.js";
import type { ControlServerRuntime } from "./runtime/Runtime.js";

export interface ControlServerOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    mcpWiringService?: McpRuntimeFactory;
    runtimeFactory?: ControlRuntimeFactory;
    startupDiagnostic?: (message: string) => void;
    xdgRuntimeDir?: string;
}

export class ControlServer {
    readonly #config: ControlConfig;
    readonly #homeDirectory?: string;
    readonly #instances: ControlInstances;
    readonly #runtimeFactory: ControlRuntimeFactory;
    readonly #socketFile: ControlSocketFile;
    readonly #startupDiagnostic: (message: string) => void;
    #operationTail: Promise<void> = Promise.resolve();
    #server?: ControlServerRuntime;
    #state?: ControlState;

    constructor(options: ControlServerOptions = {}) {
        this.#config = new ControlConfig({ store: options.configStore });
        this.#instances = new ControlInstances({
            configChanges: this.#config.changes,
        });
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
        if (this.#server !== undefined || this.#state !== undefined) return;
        await this.#instances.close();
        this.#instances.reset();
        this.#startupDiagnostic("control config load started");
        const config = await this.#config.load(this.#homeDirectory);
        this.#startupDiagnostic("control instances load started");
        await this.#instances.load(config);

        let state: ControlState | undefined;
        let server: ControlServerRuntime | undefined;
        try {
            this.#startupDiagnostic("control composition input load completed");
            this.#startupDiagnostic(
                "control runtime directory initialization started",
            );
            await this.#socketFile.ensureRuntimeDir();
            this.#startupDiagnostic(
                "control runtime directory initialization completed",
            );
            this.#startupDiagnostic("control composition started");
            const composition = await this.#runtimeFactory.create({
                config: this.#config,
                homeDirectory: this.#homeDirectory,
                instances: this.#instances,
                restart: async () => {
                    await this.restart();
                },
                shutdown: async () => {
                    await this.stop();
                },
                socketPath: this.#socketFile.path,
            });
            state = composition.state;
            server = composition.server;
            this.#startupDiagnostic("control composition completed");
            await state.initialize();
            await server.prepare();
            await server.startTransport();
            await state.start();
            await this.#instances.reconcile();
            await server.startHosts();
            await state.reconcile();
            this.#state = state;
            this.#server = server;
            this.#startupDiagnostic("control start completed");
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await server?.stop().catch((cleanupError) =>
                cleanupFailures.push(cleanupError),
            );
            await state?.close().catch((cleanupError) =>
                cleanupFailures.push(cleanupError),
            );
            await this.#instances.close().catch((cleanupError) =>
                cleanupFailures.push(cleanupError),
            );
            if (cleanupFailures.length > 0) {
                this.#state = state;
                this.#server = server;
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    "Control startup failed and cleanup was incomplete.",
                );
            }
            this.#instances.reset();
            this.#config.reset();
            throw error;
        }
    }

    async #stop(): Promise<void> {
        const failures: unknown[] = [];
        await this.#server?.stop().catch((error) => failures.push(error));
        await this.#state?.close().catch((error) => failures.push(error));
        await this.#instances.close().catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "Control failed to stop cleanly.",
            );
        }
        this.#server = undefined;
        this.#state = undefined;
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
