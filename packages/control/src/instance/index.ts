import { createInstance, type Instance } from "@portable-devshell/core";
import type { ReverseConnections } from "@portable-devshell/core/instance/transport";
import type { ControlConfig } from "@portable-devshell/shared";

import type { ConfigChangeHub } from "../config/change/Config.js";
import { InstanceChangeHub } from "./Change.js";
import type { InstanceCreateCoordinator } from "./editor/create/index.js";
import type { InstanceEditorCoordinator } from "./editor/index.js";
import { InstanceRegistry } from "./Registry.js";
import type { ReverseCredentials } from "./reverse/Credentials.js";

export interface ControlInstancesOptions {
    configChanges?: ConfigChangeHub;
}

export interface ControlInstancesRuntime {
    create: InstanceCreateCoordinator;
    editor: InstanceEditorCoordinator;
    reverse?: {
        connections: ReverseConnections;
        credentials: ReverseCredentials;
    };
}

export class ControlInstances {
    readonly changes = new InstanceChangeHub();
    readonly #unsubscribeConfigChanges: () => void;
    #create?: InstanceCreateCoordinator;
    #editor?: InstanceEditorCoordinator;
    #registry = new InstanceRegistry([]);
    #reverseConnections?: ReverseConnections;
    #reverseCredentials?: ReverseCredentials;

    constructor(options: ControlInstancesOptions = {}) {
        this.#unsubscribeConfigChanges =
            options.configChanges?.onChange((change) => {
                if (
                    change.paths.some(
                        (path) =>
                            path === "instances" ||
                            path.startsWith("instances."),
                    )
                ) {
                    this.changes.publish("config");
                }
            }) ?? (() => undefined);
    }

    get create(): InstanceCreateCoordinator {
        if (this.#create === undefined)
            throw new Error("Control instance create service is not composed.");
        return this.#create;
    }

    get editor(): InstanceEditorCoordinator {
        if (this.#editor === undefined)
            throw new Error("Control instance editor is not composed.");
        return this.#editor;
    }

    get registry(): InstanceRegistry {
        return this.#registry;
    }

    get reverseCredentials(): ReverseCredentials | undefined {
        return this.#reverseCredentials;
    }

    composeRuntime(runtime: ControlInstancesRuntime): void {
        this.#create = runtime.create;
        this.#editor = runtime.editor;
        this.#reverseConnections = runtime.reverse?.connections;
        this.#reverseCredentials = runtime.reverse?.credentials;
    }

    async reconcile(): Promise<void> {
        await this.#editor?.reconcileCleanupDebt();
    }

    async load(config: ControlConfig): Promise<void> {
        const created: Instance[] = [];
        try {
            for (const definition of config.instances) {
                if (!definition.enabled) continue;
                created.push(createInstance(definition));
            }
            this.#registry = new InstanceRegistry(created);
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            for (const instance of created)
                await instance.close().catch((cleanupError) =>
                    cleanupFailures.push(cleanupError),
                );
            this.reset();
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    "Control instance load failed and cleanup was incomplete.",
                );
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        const failures: unknown[] = [];
        try {
            this.#reverseConnections?.stop();
        } catch (error) {
            failures.push(error);
        }
        for (const instance of this.#registry.list()) {
            const supervision = instance.supervision;
            if (supervision.ownership.owned) {
                try {
                    await supervision.lifecycle.stop();
                    supervision.ownership.clearOwned();
                } catch (error) {
                    failures.push(error);
                }
            }
            await instance.close().catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Failed to close ${failures.length} instance resource(s).`,
            );
        }
    }

    reset(): void {
        this.#create = undefined;
        this.#editor = undefined;
        this.#registry = new InstanceRegistry([]);
        this.#reverseConnections = undefined;
        this.#reverseCredentials = undefined;
    }

    dispose(): void {
        this.#unsubscribeConfigChanges();
    }
}
