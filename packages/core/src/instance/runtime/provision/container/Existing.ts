import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
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
    readonly #instanceOwner: string;
    readonly #binding: string;
    readonly #resourceDirectory?: string;
    readonly #memoryResource = new ContainerAdoptionStore();
    readonly #previousOwner?: string;
    readonly #expectedGeneration?: string;
    #generation?: string;
    #startedForRuntimeRetire?: ContainerIdentity;
    #retired = false;

    constructor(options: ContainerProvisionExistingOptions) {
        this.#config = options.config;
        this.#operations = options.operations;
        this.#store = new ContainerAdoptionStore(options.adoption?.databaseFile);
        const binding = [options.operations.provider, options.operations.binary, options.config];
        this.#instanceOwner = options.adoption?.owner ?? randomUUID();
        this.#binding = containerAdoptionOwner(binding);
        this.#owner = containerAdoptionOwner([this.#instanceOwner, ...binding]);
        this.#resourceDirectory = options.adoption?.resourceDirectory ??
            (options.adoption?.databaseFile === undefined
                ? undefined
                : join(dirname(options.adoption.databaseFile), "container-resource-leases"));
        this.#previousOwner = options.adoption?.previousOwner === undefined ? undefined
            : containerAdoptionOwner([options.adoption.previousOwner, ...binding]);
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
            transaction.write(this.#adopt(started));
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
                if (record?.retiring) this.#startedForRuntimeRetire = container;
                return true;
            }
            transaction.clear();
            this.#startedForRuntimeRetire = await this.#start(container, "startContainerForRetire");
            transaction.write({ ...this.#adopt(this.#startedForRuntimeRetire), retiring: true });
            return true;
        });
    }

    async finishRuntimeRetire(): Promise<void> {
        if (this.#startedForRuntimeRetire === undefined) return;
        await this.#withIdentity(async (container, record, transaction) => {
            const started = this.#startedForRuntimeRetire;
            if (started === undefined) return;
            if (container === undefined || container.id !== started.id || container.startedAt !== started.startedAt)
                throw this.#error("Container identity changed during runtime retirement.");
            if (container.running) {
                this.#requireAdopted(record);
                await this.#stop(container, "stopContainerAfterRetire");
            }
            transaction.clear();
            this.#startedForRuntimeRetire = undefined;
        });
    }

    async afterWorkerStop(): Promise<void> {
        await this.#withIdentity(async (container, record, transaction) => {
            if (container?.running) {
                this.#requireAdopted(record);
                // Worker stop leaves this start identity in use when the
                // external container's lifecycle is not ours to stop.
                if (!this.#config.adoptLifecycle || record?.retiring) return;
                await this.#stop(container, "stopContainer");
            }
            transaction.clear();
        });
    }

    async retire(): Promise<void> {
        await this.#store.transaction(async (transaction) => {
            const record = transaction.read();
            if (record !== undefined && this.#owns(record) &&
                (this.#generation === undefined || record.generation === this.#generation)) {
                await this.#resource(record.containerId).transaction(async (lease) => {
                    const claimed = lease.read();
                    // Keep a resource fence for this still-running start, so a
                    // duplicate legacy database cannot acquire revoked authority.
                    if (claimed === undefined || this.#sameClaim(claimed, record))
                        lease.write({ ...record, databaseFile: this.#store.identity, revoked: true });
                    transaction.clear();
                });
            }
            this.#retired = true;
        });
    }

    #resource(containerId: string): ContainerAdoptionStore {
        return this.#resourceDirectory === undefined ? this.#memoryResource
            : new ContainerAdoptionStore(join(this.#resourceDirectory, `${containerId}.sqlite3`));
    }

    #owns(record: ContainerAdoptionRecord): boolean {
        return record.owner === this.#owner || record.owner === this.#previousOwner ||
            (record.binding === this.#binding && record.instanceOwner === this.#instanceOwner);
    }

    #sameClaim(lease: ContainerAdoptionRecord, record: ContainerAdoptionRecord): boolean {
        return lease.databaseFile === this.#store.identity && lease.owner === record.owner &&
            lease.generation === record.generation && lease.containerId === record.containerId && lease.startedAt === record.startedAt;
    }

    #adopt(container: ContainerIdentity): ContainerAdoptionRecord {
        this.#generation = this.#expectedGeneration ?? randomUUID();
        return {
            owner: this.#owner, generation: this.#generation,
            containerId: container.id, startedAt: container.startedAt,
            binding: this.#binding, instanceOwner: this.#instanceOwner,
        };
    }

    async #withIdentity<T>(operation: (
        container: ContainerIdentity | undefined,
        record: ContainerAdoptionRecord | undefined,
        transaction: AdoptionTransaction,
    ) => Promise<T>): Promise<T> {
        const result = await this.#store.transaction(async (transaction) => {
            if (this.#retired) return { error: this.#error("Container adoption generation is retired.") };
            const persisted = transaction.read();
            const inspected = persisted === undefined ? await this.#inspect(this.#config.containerName) : undefined;
            if (persisted === undefined && inspected?.running)
                return { error: this.#runningError() };
            let id = persisted?.containerId ?? inspected?.id;
            for (;;) {
                const resource = id === undefined ? this.#memoryResource : this.#resource(id);
                const locked = await resource.transaction(async (lease) => {
                    // Inspect inside the physical resource lock. A configured name
                    // can resolve to a new ID; release this lock before following it.
                    const container = this.#resourceDirectory === undefined && persisted === undefined
                        ? inspected : await this.#inspect(this.#config.containerName);
                    if (container !== undefined && container.id !== id) {
                        if (this.#startedForRuntimeRetire !== undefined)
                            return { error: this.#error("Container identity changed during runtime retirement.") };
                        if (persisted !== undefined && this.#owns(persisted)) {
                            if (this.#generation !== undefined && this.#generation !== persisted.generation)
                                return { error: this.#error("Container adoption generation changed.") };
                            const claimed = lease.read();
                            if (claimed !== undefined && this.#sameClaim(claimed, persisted)) lease.clear();
                            transaction.clear();
                        }
                        if (container.running) return { error: this.#runningError() };
                        return { resourceId: container.id };
                    }
                    let record = persisted;
                    let claimed = lease.read();
                    const matchesStart = (candidate: ContainerAdoptionRecord) => container?.running === true &&
                        container.id === candidate.containerId && container.startedAt === candidate.startedAt;
                    if (claimed !== undefined && !matchesStart(claimed)) {
                        lease.clear();
                        claimed = undefined;
                    }
                    if (record !== undefined && this.#owns(record)) {
                        if (this.#generation !== undefined && this.#generation !== record.generation)
                            return { error: this.#error("Container adoption generation changed.") };
                        if (!matchesStart(record)) {
                            transaction.clear();
                            record = undefined;
                        } else if (claimed !== undefined && (claimed.revoked || !this.#sameClaim(claimed, record))) {
                            transaction.clear();
                            record = undefined;
                        } else {
                            this.#generation = record.generation;
                            // Bare legacy records require the exact previous owner.
                            // Changed full-config hashes require persisted binding evidence.
                            if (record.owner !== this.#owner) {
                                record = { ...record, owner: this.#owner, ...(record.binding === undefined ? {} : { binding: this.#binding, instanceOwner: this.#instanceOwner }) };
                                transaction.write(record);
                            }
                            lease.write({ ...record, databaseFile: this.#store.identity });
                        }
                    } else {
                        record = undefined;
                    }
                    if (container !== undefined) this.#operations.setContainerTarget?.(container.id);
                    const changes: AdoptionTransaction = {
                        read: () => transaction.read(),
                        write: (value) => {
                            // Commit the resource claim before the per-instance record.
                            // A crash between commits cannot grant a second owner.
                            transaction.write(value);
                            lease.write({ ...value, databaseFile: this.#store.identity });
                        },
                        clear: () => {
                            const value = transaction.read();
                            const current = lease.read();
                            if (value !== undefined && current !== undefined && this.#sameClaim(current, value)) lease.clear();
                            transaction.clear();
                        },
                    };
                    try {
                        return { value: await operation(container, record, changes) };
                    } catch (error) {
                        // Preserve verified invalidations, and retain a live claim
                        // when provider/native cleanup fails before completing.
                        return { error };
                    }
                });
                if ("resourceId" in locked) {
                    id = locked.resourceId;
                    continue;
                }
                return locked;
            }
        });
        if ("error" in result) throw result.error;
        return result.value;
    }

    #requireAdopted(record: ContainerAdoptionRecord | undefined): void {
        if (record !== undefined) return;
        throw this.#runningError();
    }

    #runningError() {
        return this.#error(`Container ${this.#config.containerName} is already running. Running container attach is not a supported instance mode.`, { unsupportedMode: "runningContainer" });
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
