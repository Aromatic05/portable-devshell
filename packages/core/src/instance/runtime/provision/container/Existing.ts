import { randomUUID } from "node:crypto";
import {
    createRemoteError,
    runtimeErrorCodes,
    type InstanceContainerConfig,
} from "@portable-devshell/shared";

import {
    type ContainerProvision,
    type ContainerProvisionOperations,
} from "./Provision.js";
import {
    ContainerAdoptionStore,
    containerAdoptionOwner,
    type ContainerAdoptionIdentity,
    type ContainerAdoptionRecord,
    type AdoptionTransaction,
} from "./Adoption.js";

type ExistingStoppedContainerConfig = Extract<InstanceContainerConfig, { mode: "existingStoppedContainer" }>;
type ContainerIdentity = { id: string; startedAt: string; running: boolean };

interface ContainerProvisionExistingOptions {
    adoption?: ContainerAdoptionIdentity;
    config: ExistingStoppedContainerConfig;
    operations: ContainerProvisionOperations;
}

export class ContainerProvisionExisting implements ContainerProvision {
    readonly #config: ExistingStoppedContainerConfig;
    readonly #operations: ContainerProvisionOperations;
    readonly #store: ContainerAdoptionStore;
    readonly #owner: string;
    readonly #expectedGeneration?: string;
    #generation?: string;
    #startedForRuntimeRetire?: ContainerIdentity;
    #retired = false;

    constructor(options: ContainerProvisionExistingOptions) {
        this.#config = options.config;
        this.#operations = options.operations;
        this.#store = new ContainerAdoptionStore(options.adoption?.databaseFile);
        this.#owner = containerAdoptionOwner([
            options.adoption?.owner ?? randomUUID(),
            options.operations.provider,
            options.operations.binary,
            options.config,
        ]);
        this.#expectedGeneration = options.adoption?.generation;
        this.#generation = this.#expectedGeneration;
    }

    async ensureReady(_operation: string): Promise<void> {
        await this.#withIdentity(async (container, record, transaction) => {
            if (container === undefined) throw this.#error(`Configured container ${this.#config.containerName} does not exist.`);
            if (container.running) {
                this.#requireAdopted(record);
                return;
            }
            transaction.clear();
            const started = await this.#start(container, "startContainer");
            this.#generation = this.#expectedGeneration ?? randomUUID();
            transaction.write({
                owner: this.#owner,
                generation: this.#generation,
                containerId: started.id,
                startedAt: started.startedAt,
            });
        });
    }

    async isAvailable(): Promise<boolean> {
        return await this.#withIdentity(async (container, record) => {
            if (container?.running) this.#requireAdopted(record);
            return container?.running === true;
        });
    }

    async prepareRuntimeRetire(): Promise<boolean> {
        return await this.#withIdentity(async (container, record, transaction) => {
            if (container === undefined) return false;
            if (container.running) {
                this.#requireAdopted(record);
                return true;
            }
            transaction.clear();
            this.#startedForRuntimeRetire = await this.#start(container, "startContainerForRetire");
            return true;
        });
    }

    async finishRuntimeRetire(): Promise<void> {
        if (this.#startedForRuntimeRetire === undefined) return;
        await this.#withIdentity(async (container) => {
            const started = this.#startedForRuntimeRetire;
            if (started === undefined) return;
            if (container === undefined || container.id !== started.id || container.startedAt !== started.startedAt)
                throw this.#error("Container identity changed during runtime retirement.");
            if (container.running) await this.#stop(container, "stopContainerAfterRetire");
            this.#startedForRuntimeRetire = undefined;
        });
    }

    async afterWorkerStop(): Promise<void> {
        await this.#withIdentity(async (container, record, transaction) => {
            if (container?.running) {
                this.#requireAdopted(record);
                if (this.#config.adoptLifecycle) await this.#stop(container, "stopContainer");
            }
            transaction.clear();
        });
    }

    async retire(): Promise<void> {
        await this.#store.transaction(async (transaction) => {
            const record = transaction.read();
            if (record?.owner === this.#owner && this.#generation !== undefined && record.generation === this.#generation)
                transaction.clear();
            this.#retired = true;
        });
    }

    async #withIdentity<T>(operation: (
        container: ContainerIdentity | undefined,
        record: ContainerAdoptionRecord | undefined,
        transaction: AdoptionTransaction,
    ) => Promise<T>): Promise<T> {
        const result = await this.#store.transaction(async (transaction) => {
            if (this.#retired) return { error: this.#error("Container adoption generation is retired.") };
            const container = await this.#inspect(this.#config.containerName);
            let record = transaction.read();
            if (record?.owner === this.#owner) {
                if (this.#generation !== undefined && this.#generation !== record.generation)
                    return { error: this.#error("Container adoption generation changed.") };
                if (container === undefined || container.id !== record.containerId || !container.running || container.startedAt !== record.startedAt) {
                    transaction.clear();
                    record = undefined;
                } else {
                    this.#generation = record.generation;
                }
            } else {
                record = undefined;
            }
            // Pin execution and lifecycle commands to the verified immutable ID.
            if (container !== undefined) this.#operations.setContainerTarget?.(container.id);
            try {
                return { value: await operation(container, record, transaction) };
            } catch (error) {
                // Commit identity invalidation even when the requested operation
                // refuses an unproven running container or a provider start fails.
                return { error };
            }
        });
        if ("error" in result) throw result.error;
        return result.value;
    }

    #requireAdopted(record: ContainerAdoptionRecord | undefined): void {
        if (record !== undefined) return;
        throw this.#error(`Container ${this.#config.containerName} is already running. Running container attach is not a supported instance mode.`, { unsupportedMode: "runningContainer" });
    }

    async #start(container: ContainerIdentity, operation: string): Promise<ContainerIdentity> {
        await this.#operations.runProviderCommand(operation, ["start", container.id]);
        const started = await this.#inspect(container.id);
        if (started === undefined || started.id !== container.id || !started.running)
            throw this.#error("Started container identity could not be verified.");
        this.#operations.setContainerTarget?.(started.id);
        return started;
    }

    async #stop(container: ContainerIdentity, operation: string): Promise<void> {
        await this.#operations.runProviderCommand(operation, ["stop", container.id]);
        const stopped = await this.#inspect(container.id);
        if (stopped !== undefined && (stopped.id !== container.id || stopped.running)) throw this.#error("Container is still running after stop.");
    }

    async #inspect(target: string): Promise<ContainerIdentity | undefined> {
        const result = await this.#operations.runProviderCommand("inspectContainerIdentity", [
            "inspect", "--type", "container", target,
        ], { allowNonZeroExit: true });
        if (result.exitCode !== 0) {
            if (/no such (container|object)/iu.test(result.stderr + result.stdout)) return undefined;
            throw this.#error(result.stderr || result.stdout || "Container identity inspection failed.", { operation: "inspectContainerIdentity", exitCode: result.exitCode });
        }
        const inspected: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(inspected) || inspected.length !== 1) throw this.#error("Invalid container identity inspection.");
        const value = inspected[0] as { Id?: unknown; State?: { Status?: unknown; StartedAt?: unknown } } | null;
        if (value === null || typeof value.Id !== "string" || !/^[a-f0-9]{64}$/iu.test(value.Id) ||
            typeof value.State?.Status !== "string" || typeof value.State.StartedAt !== "string" ||
            (value.State.Status === "running" && !(Date.parse(value.State.StartedAt) > 0)))
            throw this.#error("Invalid container identity inspection.");
        return { id: value.Id, running: value.State.Status === "running", startedAt: value.State.StartedAt };
    }

    #error(message: string, details = {}) {
        return createRemoteError({
            code: runtimeErrorCodes.providerFailed,
            details: {
                containerName: this.#config.containerName,
                mode: "existingStoppedContainer",
                provider: this.#operations.provider,
                ...details,
            },
            message,
            retryable: false,
        });
    }
}
