import type { ControlConfig as ControlConfigDocument } from "@portable-devshell/shared";
import { ControlSocketFile } from "@portable-devshell/shared";

import type { ControlState } from "./State.js";
import { ControlConfig } from "./config/index.js";
import type { ControlConfigStore } from "./config/store/index.js";
import { ControlInstances } from "./instance/index.js";
import type { McpRuntimeFactory } from "./server/mcp/Runtime.js";
import { ControlFactory } from "./Factory.js";
import type { ControlServer } from "./server/index.js";

export interface ControlOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    mcpWiringService?: McpRuntimeFactory;
    factory?: ControlFactory;
    startupDiagnostic?: (message: string) => void;
    xdgRuntimeDir?: string;
}

export class Control {
    readonly #config: ControlConfig;
    readonly #homeDirectory?: string;
    readonly #instances: ControlInstances;
    readonly #factory: ControlFactory;
    readonly #socketFile: ControlSocketFile;
    readonly #startupDiagnostic: (message: string) => void;
    #operationTail: Promise<void> = Promise.resolve();
    #backgroundCleanup?: {
        controller: AbortController;
        timer?: ReturnType<typeof setImmediate>;
    };
    #server?: ControlServer;
    #state?: ControlState;

    constructor(options: ControlOptions = {}) {
        this.#config = new ControlConfig({ store: options.configStore });
        this.#instances = new ControlInstances();
        this.#config.changes.onChange((change) => {
            if (
                change.paths.some(
                    (path) =>
                        path === "instances" ||
                        path.startsWith("instances."),
                )
            ) {
                this.#instances.changes.publish("config");
            }
        });
        this.#homeDirectory = options.homeDirectory;
        this.#factory =
            options.factory ??
            new ControlFactory({
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
        let server: ControlServer | undefined;
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
            const composition = await this.#factory.create({
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
            // Historical debt cannot hold healthy instances hostage.
            // Recover by named lifecycle admission or the explicit cleanup CLI.
            await server.startHosts();
            await state.reconcile();
            this.#state = state;
            this.#server = server;
            server.markReady();
            this.#scheduleCleanupRecovery(server);
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
        this.#cancelCleanupRecovery();
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

    #scheduleCleanupRecovery(server: ControlServer): void {
        this.#cancelCleanupRecovery();
        const recovery: {
            controller: AbortController;
            timer?: ReturnType<typeof setImmediate>;
        } = { controller: new AbortController() };
        this.#backgroundCleanup = recovery;
        // Start after markReady and after the initiating lifecycle operation
        // has yielded. An unreachable legacy provider must not block Control.
        recovery.timer = setImmediate(() => {
            recovery.timer = undefined;
            if (this.#backgroundCleanup !== recovery ||
                recovery.controller.signal.aborted || this.#server !== server) return;
            void this.#instances.reconcile(recovery.controller.signal)
                .catch((error: unknown) =>
                    console.warn("Deferred instance cleanup recovery failed:", error),
                ).finally(() => {
                    if (this.#backgroundCleanup === recovery)
                        this.#backgroundCleanup = undefined;
                });
        });
        recovery.timer.unref();
    }

    #cancelCleanupRecovery(): void {
        const recovery = this.#backgroundCleanup;
        this.#backgroundCleanup = undefined;
        if (recovery === undefined) return;
        recovery.controller.abort(
            new Error("Control lifecycle ended before cleanup recovery completed."),
        );
        if (recovery.timer !== undefined) clearImmediate(recovery.timer);
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
