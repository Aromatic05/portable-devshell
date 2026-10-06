import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
    createRemoteError,
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft,
    toConfigInstanceDraft,
    type ControlConfig,
    runtimeErrorCodes,
} from "@portable-devshell/shared";
import { retireInstanceForDelete, type Instance, type InstanceRegistry } from "@portable-devshell/core";
import type { ConfigEngine } from "../../../config/engine/index.js";
import type { InstanceEditorCoordinatorOptions } from "../Options.js";
import { InstanceChangeHub } from "../../Change.js";
import { closeDescriptorResourcesBestEffort } from "./State.js";
import type { InstanceRetirementCoordinator } from "./index.js";

export interface InstanceCleanupDebtRecord {
    instance: ControlConfig["instances"][number];
    operation: "delete" | "disable" | "rebuild";
    skipRuntimeRetirement?: boolean;
}

class InstanceCleanupDebtStore {
    readonly #filePath?: string;
    readonly #records = new Map<string, InstanceCleanupDebtRecord>();
    #loaded = false;
    #tail = Promise.resolve();

    constructor(filePath?: string) {
        this.#filePath = filePath;
    }

    async get(
        instance: string,
    ): Promise<InstanceCleanupDebtRecord | undefined> {
        return await this.#exclusive(async () => this.#records.get(instance));
    }

    async list(): Promise<InstanceCleanupDebtRecord[]> {
        return await this.#exclusive(async () => [...this.#records.values()]);
    }

    async put(record: InstanceCleanupDebtRecord): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#records.get(record.instance.name);
            this.#records.set(record.instance.name, record);
            try {
                await this.#persist();
            } catch (error) {
                if (previous === undefined)
                    this.#records.delete(record.instance.name);
                else this.#records.set(record.instance.name, previous);
                throw error;
            }
        });
    }

    async clear(instance: string): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#records.get(instance);
            if (previous === undefined) return;
            this.#records.delete(instance);
            try {
                await this.#persist();
            } catch (error) {
                this.#records.set(instance, previous);
                throw error;
            }
        });
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            await this.#load();
            return await operation();
        } finally {
            release();
        }
    }

    async #load(): Promise<void> {
        if (this.#loaded) return;
        this.#loaded = true;
        if (this.#filePath === undefined) return;
        let source: string;
        try {
            source = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            this.#loaded = false;
            throw error;
        }
        try {
            const parsed = JSON.parse(source) as unknown;
            if (!Array.isArray(parsed)) {
                throw new Error(
                    `Invalid lifecycle cleanup state: ${this.#filePath}.`,
                );
            }
            this.#records.clear();
            for (const value of parsed) {
                const record = parseCleanupDebtRecord(value);
                this.#records.set(record.instance.name, record);
            }
        } catch (error) {
            this.#records.clear();
            this.#loaded = false;
            throw error;
        }
    }

    async #persist(): Promise<void> {
        if (this.#filePath === undefined) return;
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
            const persisted = [...this.#records.values()].map((record) => ({
                ...record,
                instance: toConfigInstanceDraft(record.instance),
            }));
            await file.writeFile(`${JSON.stringify(persisted)}\n`, "utf8");
            await file.sync();
        } catch (error) {
            await file.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        await file.close();
        try {
            await rename(temporary, this.#filePath);
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        if (process.platform !== "win32") {
            const parent = await open(directory, "r");
            try {
                await parent.sync();
            } finally {
                await parent.close();
            }
        }
    }
}

function parseCleanupDebtRecord(value: unknown): InstanceCleanupDebtRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Invalid lifecycle cleanup record.");
    }
    const record = value as Record<string, unknown>;
    if (
        record.operation !== "delete" &&
        record.operation !== "disable" &&
        record.operation !== "rebuild"
    ) {
        throw new Error("Invalid lifecycle cleanup operation.");
    }
    const instance = normalizeConfigInstanceDraft(
        parseConfigInstanceDraft(record.instance, ["instance"]),
    );
    if (
        record.skipRuntimeRetirement !== undefined &&
        typeof record.skipRuntimeRetirement !== "boolean"
    ) {
        throw new Error("Invalid lifecycle cleanup retirement flag.");
    }
    return {
        instance,
        operation: record.operation,
        ...(record.skipRuntimeRetirement === undefined
            ? {}
            : {
                  skipRuntimeRetirement: record.skipRuntimeRetirement,
              }),
    };
}

export class InstanceCleanupDebt {
    readonly #cleanupDebts: InstanceCleanupDebtStore;
    readonly #cleanupOnlyDescriptors = new Map<string, Instance | undefined>();
    readonly #mcp: InstanceEditorCoordinatorOptions["mcp"];
    readonly #engine: ConfigEngine;
    readonly #instanceChanges: InstanceChangeHub;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #retirement: InstanceRetirementCoordinator;
    readonly #syncMcpEndpoint: (instance: string) => Promise<void>;
    readonly #createRuntimeInstance: InstanceEditorCoordinatorOptions["createRuntimeInstance"];
    readonly #retireRuntimeInstance: InstanceEditorCoordinatorOptions["retireRuntimeInstance"];
    readonly #finalizeRuntimeInstance: InstanceEditorCoordinatorOptions["finalizeRuntimeInstance"];

    constructor(
        options: InstanceEditorCoordinatorOptions,
        retirement: InstanceRetirementCoordinator,
        syncMcpEndpoint: (instance: string) => Promise<void>,
    ) {
        this.#cleanupDebts = new InstanceCleanupDebtStore(
            options.cleanupDebtFile,
        );
        this.#engine = options.engine;
        this.#mcp = options.mcp;
        this.#instanceChanges = options.instanceChanges;
        this.#instanceRegistry = options.instanceRegistry;
        this.#retirement = retirement;
        this.#syncMcpEndpoint = syncMcpEndpoint;
        this.#createRuntimeInstance = options.createRuntimeInstance;
        this.#retireRuntimeInstance = options.retireRuntimeInstance;
        this.#finalizeRuntimeInstance = options.finalizeRuntimeInstance;
    }

    retainDescriptor(
        instance: string,
        descriptor: Instance,
    ): void {
        this.#cleanupOnlyDescriptors.set(instance, descriptor);
    }

    releaseDescriptor(instance: string): void {
        this.#cleanupOnlyDescriptors.delete(instance);
    }

    async recordDebt(record: InstanceCleanupDebtRecord): Promise<void> {
        await this.#cleanupDebts.put(record);
    }

    async clearDebt(instance: string): Promise<void> {
        await this.#cleanupDebts.clear(instance);
    }

    async assertInstanceCleanupSettled(instance: string): Promise<void> {
        if ((await this.#cleanupDebts.get(instance)) === undefined) return;
        if (this.#instanceRegistry.get(instance) === undefined) {
            await this.reconcileCleanupDebt(instance);
        }
        if ((await this.#cleanupDebts.get(instance)) === undefined) return;
        throw createRemoteError({
            code: runtimeErrorCodes.instanceConflict,
            details: { instance, operation: "cleanup" },
            message: `Instance ${instance} still has incomplete lifecycle cleanup.`,
            retryable: true,
        });
    }

    async reconcileCleanupDebt(instance?: string): Promise<void> {
        for (const record of await this.#cleanupDebts.list()) {
            if (instance !== undefined && record.instance.name !== instance)
                continue;
            const failures =
                record.operation === "rebuild"
                    ? await this.#reconcileRebuildCleanup(record)
                    : await this.#reconcileCleanupRecord(record);
            if (failures.length === 0) {
                await this.#cleanupDebts.clear(record.instance.name);
                continue;
            }
            warnCommittedCleanupFailures(
                record.instance.name,
                record.operation === "delete" ? "delete" : "update",
                failures,
            );
        }
    }

    async cleanupCommittedInstanceChangeWithDebt(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: Instance | undefined,
        preparedDescriptor: Instance | undefined,
        rebuildRequired: boolean,
        cleanup: () => Promise<unknown[]>,
    ): Promise<void> {
        const debt: InstanceCleanupDebtRecord | undefined =
            existing !== undefined &&
            next !== undefined &&
            existing.enabled &&
            !next.enabled
                ? {
                      instance: existing,
                      operation: "disable",
                  }
                : existing !== undefined &&
                    next !== undefined &&
                    existing.enabled &&
                    next.enabled &&
                    rebuildRequired &&
                    descriptor !== undefined &&
                    preparedDescriptor !== undefined &&
                    descriptor !== preparedDescriptor
                  ? {
                        instance: existing,
                        operation: "rebuild",
                    }
                  : undefined;
        const failures: unknown[] = [];
        let debtPersisted = false;
        if (debt !== undefined) {
            await this.#cleanupDebts
                .put(debt)
                .then(() => {
                    debtPersisted = true;
                })
                .catch((error) => failures.push(error));
        }
        const cleanupFailures = await cleanup();
        failures.push(...cleanupFailures);
        const cleanupSettled =
            debt?.operation === "rebuild"
                ? preparedDescriptor !== undefined &&
                  this.#instanceRegistry.get(debt.instance.name) ===
                      preparedDescriptor
                : cleanupFailures.length === 0;
        if (debt !== undefined && debtPersisted && cleanupSettled) {
            await this.#cleanupDebts
                .clear(debt.instance.name)
                .catch((error) => failures.push(error));
        }
        warnCommittedCleanupFailures(
            next?.name ?? existing?.name ?? "unknown",
            "update",
            failures,
        );
    }

    async #reconcileRebuildCleanup(
        record: InstanceCleanupDebtRecord,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        let candidate = this.#instanceRegistry.get(record.instance.name);
        if (candidate !== undefined) {
            try {
                await this.#instanceRegistry.remove(
                    record.instance.name,
                    candidate,
                    async (retiring) =>
                        await this.#retireRuntimeInstance(retiring),
                );
                this.#instanceChanges.publish("registry");
            } catch (error) {
                failures.push(error);
                return failures;
            }
        }
        await this.#retirement.notification
            .retireGenerationResources(record.instance)
            .catch((error) => failures.push(error));

        if (failures.length > 0) {
            if (candidate !== undefined) {
                await closeDescriptorResourcesBestEffort(
                    candidate,
                    this.#finalizeRuntimeInstance,
                ).catch(
                    (error) => failures.push(error),
                );
            }
            return failures;
        }

        if (candidate === undefined) {
            const configured = this.#engine.current.instances.find(
                (instance) =>
                    instance.name === record.instance.name && instance.enabled,
            );
            if (configured !== undefined) {
                candidate = this.#createRuntimeInstance(configured);
            }
        }
        if (candidate === undefined) return failures;

        try {
            this.#instanceRegistry.add(candidate);
            this.#instanceChanges.publish("registry");
            await this.#syncMcpEndpoint(record.instance.name);
        } catch (error) {
            failures.push(error);
            if (
                this.#instanceRegistry.get(record.instance.name) === candidate
            ) {
                await this.#instanceRegistry
                    .remove(record.instance.name, candidate)
                    .catch((cleanupError) => failures.push(cleanupError));
                this.#instanceChanges.publish("registry");
                await this.#syncMcpEndpoint(record.instance.name).catch(
                    (cleanupError) => failures.push(cleanupError),
                );
            }
            await closeDescriptorResourcesBestEffort(
                candidate,
                this.#finalizeRuntimeInstance,
            ).catch(
                (cleanupError) => failures.push(cleanupError),
            );
        }
        return failures;
    }

    async #reconcileCleanupRecord(
        record: InstanceCleanupDebtRecord,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        const descriptor =
            this.#cleanupOnlyDescriptors.get(record.instance.name) ??
            this.#createRuntimeInstance(record.instance);
        this.#cleanupOnlyDescriptors.set(record.instance.name, descriptor);
        if (record.operation === "delete") {
            this.#cleanupOnlyDescriptors.set(record.instance.name, descriptor);
            try {
                await this.#retirement.prepareContextCleanup(
                    record.instance.name,
                    descriptor,
                );
            } catch (error) {
                failures.push(error);
                return failures;
            }
        }
        if (!descriptor.retired) {
            await descriptor
                .retire(async () => {
                    await this.#retireRuntimeInstance(descriptor);
                })
                .catch((error) => failures.push(error));
        }
        await this.#retirement.notification
            .retireGenerationResources(record.instance)
            .catch((error) => failures.push(error));
        let workerRetirementSucceeded = false;
        if (record.operation === "disable") {
            failures.push(
                ...(await this.#retirement.notification.retireDisable(
                    record.instance,
                )),
            );
            await this.#mcp
                ?.retireMcpApp(record.instance.name)
                .catch((error) => failures.push(error));
            try {
                await descriptor.worker.stop();
                workerRetirementSucceeded = true;
            } catch (error) {
                failures.push(error);
            }
            await this.#retirement.notification
                .notifyDisabled(record.instance)
                .catch((error) => failures.push(error));
        } else {
            failures.push(
                ...(await this.#retirement.notification.retireDelete(
                    record.instance,
                )),
            );
            try {
                await retireInstanceForDelete(
                    descriptor,
                    record.skipRuntimeRetirement,
                );
                workerRetirementSucceeded = true;
            } catch (error) {
                failures.push(error);
            }
            await this.#retirement.notification
                .notifyDeleted(record.instance)
                .catch((error) => failures.push(error));
        }
        let descriptorFinalized = false;
        if (workerRetirementSucceeded) {
            await closeDescriptorResourcesBestEffort(
                descriptor,
                this.#finalizeRuntimeInstance,
            )
                .then(() => {
                    descriptorFinalized = true;
                })
                .catch((error) => failures.push(error));
        }
        if (
            descriptorFinalized &&
            this.#cleanupOnlyDescriptors.get(record.instance.name) === descriptor
        ) {
            this.#cleanupOnlyDescriptors.delete(record.instance.name);
        }
        return failures;
    }
}

export function warnCommittedCleanupFailures(
    instance: string,
    operation: "delete" | "update",
    failures: readonly unknown[],
): void {
    if (failures.length === 0) return;
    console.warn(
        new AggregateError(
            [...failures],
            `Instance ${instance} ${operation} committed but cleanup was incomplete.`,
        ),
    );
}
