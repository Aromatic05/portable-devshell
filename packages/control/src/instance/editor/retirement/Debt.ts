import type { InstanceRegistry } from "../../Registry.js";
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
import type { Instance } from "@portable-devshell/core";
import type { ConfigEngine } from "../../../config/engine/index.js";
import type { InstanceEditorCoordinatorOptions } from "../Options.js";
import { InstanceChangeHub } from "../../Change.js";
import { closeDescriptorResourcesBestEffort } from "./State.js";
import type { InstanceRetirementHooks } from "./Hooks.js";

export interface InstanceCleanupDebtRecord {
    /** Controller retirement record identity; not a remote Worker identifier. */
    generationId?: string;
    createdAt?: string;
    lastFailure?: string;
    instance: ControlConfig["instances"][number];
    operation: "delete" | "disable" | "rebuild";
    /** Remote target could not be safely retired; never replay by name. */
    remoteAbandoned?: boolean;
    /** Local cleanup completed; retained solely as an orphan resource record. */
    orphaned?: boolean;
    skipRuntimeRetirement?: boolean;
    /** Unreleased volatile remote scopes, handed off from the Context ledger. */
    abandonedContextAlerts?: string[];
}

export interface InstanceCleanupStatus {
    cleanupPending: boolean;
    cleanupWarnings?: string[];
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
        return await this.#exclusive(async () => this.#pendingRecord(instance)?.[1]);
    }

    async list(): Promise<InstanceCleanupDebtRecord[]> {
        return await this.#exclusive(async () => [...this.#records.values()]);
    }

    async put(record: InstanceCleanupDebtRecord): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#pendingRecord(record.instance.name);
            const generationId = record.generationId ?? randomUUID();
            if (previous !== undefined) this.#records.delete(previous[0]);
            this.#records.set(generationId, {
                ...record,
                generationId,
                createdAt: record.createdAt ?? new Date().toISOString(),
            });
            try {
                await this.#persist();
            } catch (error) {
                this.#records.delete(generationId);
                if (previous !== undefined) this.#records.set(previous[0], previous[1]);
                throw error;
            }
        });
    }

    async recordFailure(instance: string, error: unknown): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#pendingRecord(instance);
            if (previous === undefined) return;
            const [id, record] = previous;
            this.#records.set(id, {
                ...record,
                lastFailure: describeDebtFailure(error).slice(0, 500),
            });
            try {
                await this.#persist();
            } catch (failure) {
                this.#records.set(id, record);
                throw failure;
            }
        });
    }

    async clear(instance: string): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#pendingRecord(instance);
            if (previous === undefined) return;
            const [id, record] = previous;
            if (record.remoteAbandoned) this.#records.set(id, { ...record, orphaned: true });
            else this.#records.delete(id);
            try {
                await this.#persist();
            } catch (error) {
                this.#records.set(id, record);
                throw error;
            }
        });
    }

    async markRemoteAbandoned(instance: string): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#pendingRecord(instance);
            if (previous === undefined) return;
            const [id, record] = previous;
            this.#records.set(id, { ...record, remoteAbandoned: true });
            try {
                await this.#persist();
            } catch (error) {
                this.#records.set(id, record);
                throw error;
            }
        });
    }

    async abandonContextAlerts(instance: string, workspace: string): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#pendingRecord(instance);
            if (previous === undefined) throw new Error(`Missing cleanup debt for ${instance}.`);
            const [id, record] = previous;
            this.#records.set(id, {
                ...record,
                remoteAbandoned: true,
                abandonedContextAlerts: [...new Set([...(record.abandonedContextAlerts ?? []), workspace])],
                lastFailure: "Offline self-managed Worker alert scopes require manual cleanup; never replay against a replacement generation.",
            });
            let replaced = false;
            try {
                await this.#persist(() => { replaced = true; });
            } catch (error) {
                // A directory-sync failure after rename must not forget the
                // handoff and allow a later connection to replay it remotely.
                if (!replaced) this.#records.set(id, record);
                throw error;
            }
        });
    }

    #pendingRecord(instance: string): [string, InstanceCleanupDebtRecord] | undefined {
        return [...this.#records.entries()].find(([, record]) =>
            record.instance.name === instance && record.orphaned !== true);
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
                const generationId = record.generationId ?? `legacy:${record.instance.name}`;
                this.#records.set(generationId, { ...record, generationId });
            }
        } catch (error) {
            this.#records.clear();
            this.#loaded = false;
            throw error;
        }
    }

    async #persist(onReplaced?: () => void): Promise<void> {
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
        onReplaced?.();
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
    if (record.generationId !== undefined &&
        (typeof record.generationId !== "string" || record.generationId.length === 0))
        throw new Error("Invalid lifecycle cleanup generation identity.");
    if (record.remoteAbandoned !== undefined && typeof record.remoteAbandoned !== "boolean")
        throw new Error("Invalid lifecycle remote abandonment state.");
    if (record.orphaned !== undefined && typeof record.orphaned !== "boolean")
        throw new Error("Invalid lifecycle orphan state.");
    if (record.createdAt !== undefined && typeof record.createdAt !== "string")
        throw new Error("Invalid cleanup debt creation time.");
    if (record.lastFailure !== undefined && typeof record.lastFailure !== "string")
        throw new Error("Invalid cleanup debt failure description.");
    if (record.abandonedContextAlerts !== undefined &&
        (!Array.isArray(record.abandonedContextAlerts) ||
            !record.abandonedContextAlerts.every((workspace) => typeof workspace === "string")))
        throw new Error("Invalid abandoned Context alert scopes.");
    return {
        ...(record.generationId === undefined ? {} : { generationId: record.generationId as string }),
        instance,
        operation: record.operation,
        ...(record.remoteAbandoned === undefined ? {} : { remoteAbandoned: record.remoteAbandoned as boolean }),
        ...(record.orphaned === undefined ? {} : { orphaned: record.orphaned as boolean }),
        ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt as string }),
        ...(record.lastFailure === undefined ? {} : { lastFailure: record.lastFailure as string }),
        ...(record.abandonedContextAlerts === undefined ? {} : { abandonedContextAlerts: record.abandonedContextAlerts as string[] }),
        ...(record.skipRuntimeRetirement === undefined
            ? {}
            : {
                  skipRuntimeRetirement: record.skipRuntimeRetirement,
              }),
    };
}

export class InstanceCleanupDebt {
    readonly #cleanupDebts: InstanceCleanupDebtStore;
    // A committed retirement owns its name until every cleanup side effect
    // finishes. Reconciliation joins that operation instead of replaying it.
    readonly #activeCleanups = new Map<string, Promise<void>>();
    readonly #cleanupOnlyDescriptors = new Map<string, Instance | undefined>();
    readonly #mcp: InstanceEditorCoordinatorOptions["mcp"];
    readonly #engine: ConfigEngine;
    readonly #instanceChanges: InstanceChangeHub;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #isPreviousLifecycleRecoveryPending?: (instance: string) => boolean;
    readonly #hooks: InstanceRetirementHooks;
    readonly #prepareContextCleanup: (
        instance: string,
        descriptor: Instance | undefined,
    ) => Promise<void>;
    readonly #syncMcpEndpoint: (instance: string) => Promise<void>;
    readonly #createRuntimeInstance: InstanceEditorCoordinatorOptions["createRuntimeInstance"];
    readonly #finalizeRuntimeInstance: InstanceEditorCoordinatorOptions["finalizeRuntimeInstance"];
    readonly #detachContextInstance: InstanceEditorCoordinatorOptions["detachContextInstance"];
    readonly #reconcileContextInstanceCleanup: InstanceEditorCoordinatorOptions["reconcileContextInstanceCleanup"];

    constructor(
        options: InstanceEditorCoordinatorOptions,
        hooks: InstanceRetirementHooks,
        prepareContextCleanup: (
            instance: string,
            descriptor: Instance | undefined,
        ) => Promise<void>,
        syncMcpEndpoint: (instance: string) => Promise<void>,
    ) {
        this.#cleanupDebts = new InstanceCleanupDebtStore(
            options.cleanupDebtFile,
        );
        this.#engine = options.engine;
        this.#mcp = options.mcp;
        this.#instanceChanges = options.instanceChanges;
        this.#instanceRegistry = options.instanceRegistry;
        this.#isPreviousLifecycleRecoveryPending = options.isPreviousLifecycleRecoveryPending;
        this.#hooks = hooks;
        this.#prepareContextCleanup = prepareContextCleanup;
        this.#syncMcpEndpoint = syncMcpEndpoint;
        this.#createRuntimeInstance = options.createRuntimeInstance;
        this.#finalizeRuntimeInstance = options.finalizeRuntimeInstance;
        this.#detachContextInstance = options.detachContextInstance;
        this.#reconcileContextInstanceCleanup = options.reconcileContextInstanceCleanup;
    }

    retainDescriptor(instance: string, descriptor: Instance): void {
        this.#cleanupOnlyDescriptors.set(instance, descriptor);
    }

    releaseDescriptor(instance: string): void {
        this.#cleanupOnlyDescriptors.delete(instance);
    }

    async recordDebt(record: InstanceCleanupDebtRecord): Promise<void> {
        await this.#cleanupDebts.put(record);
    }

    /** Read-only, sanitized projection; never expose full provider credentials. */
    async listCleanupDebts(): Promise<Array<Record<string, string>>> {
        return (await this.#cleanupDebts.list()).map((record) => ({
            generationId: record.generationId ?? "legacy",
            instance: record.instance.name,
            provider: record.instance.provider,
            target: cleanupTargetDescription(record.instance),
            operation: record.operation,
            state: record.orphaned ? "orphaned" : "pending",
            ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
            ...(record.lastFailure === undefined ? {} : { reason: record.lastFailure }),
            ...(record.abandonedContextAlerts === undefined ? {} : { abandonedContextAlertCount: String(record.abandonedContextAlerts.length) }),
            guidance: record.orphaned
                ? "Inspect the old remote resource manually; no immutable remote generation identity is available."
                : "Retry with: devshell instance cleanup retry " + record.instance.name,
        }));
    }

    async rememberCleanupFailure(instance: string, error: unknown): Promise<void> {
        await this.#cleanupDebts.recordFailure(instance, error);
    }

    async clearDebt(instance: string): Promise<void> {
        await this.#cleanupDebts.clear(instance);
    }

    async markRemoteAbandoned(instance: string): Promise<void> {
        await this.#cleanupDebts.markRemoteAbandoned(instance);
    }

    async reconcileSelfManagedContextCleanup(instance: string, descriptor: Instance): Promise<void> {
        await this.#reconcileContextInstanceCleanup?.(instance, {
            releaseReference: (reference) => descriptor.supervision.ownership.releaseReference(reference),
            releaseAlerts: async (workspace) => {
                const record = await this.#cleanupDebts.get(instance);
                if (record === undefined) throw new Error(`Missing cleanup debt for ${instance}.`);
                // A failed Context-ledger write can retry this handoff. Never
                // release an already orphaned scope on a later connection.
                if (record.abandonedContextAlerts?.includes(workspace)) {
                    // Reconfirm durability even if the earlier rename's sync
                    // acknowledgement failed before Context could settle.
                    await this.#cleanupDebts.abandonContextAlerts(instance, workspace);
                    return;
                }
                if (descriptor.supervision.snapshot().ready) {
                    await descriptor.environment.releaseAlerts(workspace);
                    return;
                }
                // Offline does not prove the daemon stopped. Preserve exact
                // old scopes before handing them off from the Context ledger.
                await this.#cleanupDebts.abandonContextAlerts(instance, workspace);
            },
        });
    }

    reserveCommittedCleanup(instance: string): () => void {
        if (this.#activeCleanups.has(instance)) {
            throw this.#cleanupConflict(instance);
        }
        let resolve!: () => void;
        const pending = new Promise<void>((done) => { resolve = done; });
        this.#activeCleanups.set(instance, pending);
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            if (this.#activeCleanups.get(instance) === pending) {
                this.#activeCleanups.delete(instance);
            }
            resolve();
        };
    }

    async assertInstanceCleanupSettled(
        instance: string,
        reconcile = true,
    ): Promise<void> {
        if (this.#isPreviousLifecycleRecoveryPending?.(instance))
            throw this.#cleanupConflict(instance);
        const active = this.#activeCleanups.get(instance);
        // Callers inside ConfigEngine.runExclusive must never wait for a
        // cleanup which can itself need the configuration transaction.
        if (active !== undefined) {
            if (!reconcile) throw this.#cleanupConflict(instance);
            await active;
        }
        if ((await this.#cleanupDebts.get(instance)) === undefined) return;
        if (reconcile && this.#instanceRegistry.get(instance) === undefined) {
            await this.reconcileCleanupDebt(instance);
        }
        if ((await this.#cleanupDebts.get(instance)) === undefined) return;
        throw this.#cleanupConflict(instance);
    }

    async reconcileCleanupDebt(instance?: string): Promise<void> {
        if (instance !== undefined && this.#isPreviousLifecycleRecoveryPending?.(instance))
            throw this.#cleanupConflict(instance);
        for (const record of await this.#cleanupDebts.list()) {
            if (record.orphaned) continue;
            if (instance !== undefined && record.instance.name !== instance)
                continue;
            if (this.#isPreviousLifecycleRecoveryPending?.(record.instance.name))
                continue;
            const active = this.#activeCleanups.get(record.instance.name);
            if (active !== undefined) {
                await active;
                continue;
            }
            const finish = this.reserveCommittedCleanup(record.instance.name);
            try {
                // Another reconciler may have settled or replaced the debt
                // while the original list was being read.
                const current = await this.#cleanupDebts.get(record.instance.name);
                if (current === undefined || current.orphaned ||
                    current.generationId !== record.generationId) continue;
                try {
                    const failures =
                        current.operation === "rebuild"
                            ? await this.#reconcileRebuildCleanup(current)
                            : await this.#reconcileCleanupRecord(current);
                    if (failures.length === 0) {
                        await this.#cleanupDebts.clear(current.instance.name);
                        continue;
                    }
                    await this.#cleanupDebts.recordFailure(current.instance.name, failures[0])
                        .catch((error) => console.warn("Could not persist cleanup failure:", error));
                    warnCommittedCleanupFailures(
                        current.instance.name,
                        current.operation === "delete" ? "delete" : "update",
                        failures,
                    );
                } catch (error) {
                    await this.#cleanupDebts.recordFailure(current.instance.name, error)
                        .catch((persistError) => console.warn("Could not persist cleanup failure:", persistError));
                    warnCommittedCleanupFailures(
                        current.instance.name,
                        current.operation === "delete" ? "delete" : "update",
                        [error],
                    );
                }
            } finally {
                finish();
            }
        }
    }

    #cleanupConflict(instance: string): Error {
        return createRemoteError({
            code: runtimeErrorCodes.instanceConflict,
            details: { instance, operation: "cleanup" },
            message: `Instance ${instance} still has incomplete lifecycle cleanup.`,
            retryable: true,
        });
    }

    async cleanupCommittedInstanceChangeWithDebt(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: Instance | undefined,
        preparedDescriptor: Instance | undefined,
        rebuildRequired: boolean,
        cleanup: () => Promise<unknown[]>,
    ): Promise<InstanceCleanupStatus> {
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
        const cleanupFailures = await cleanup().catch((error) => [error]);
        failures.push(...cleanupFailures);
        const cleanupSettled =
            cleanupFailures.length === 0 &&
            (debt?.operation !== "rebuild" ||
                (preparedDescriptor !== undefined &&
                    this.#instanceRegistry.get(debt.instance.name) ===
                        preparedDescriptor));
        if (debt !== undefined && debtPersisted && cleanupSettled) {
            await this.#cleanupDebts
                .clear(debt.instance.name)
                .catch((error) => failures.push(error));
        }
        if (debtPersisted && debt !== undefined && failures.length > 0)
            await this.#cleanupDebts.recordFailure(debt.instance.name, failures[0])
                .catch((error) => failures.push(error));
        warnCommittedCleanupFailures(
            next?.name ?? existing?.name ?? "unknown",
            "update",
            failures,
        );
        return {
            cleanupPending:
                failures.length > 0 ||
                (debt !== undefined && (!debtPersisted || !cleanupSettled)),
            ...(failures.length === 0 ? {} : {
                cleanupWarnings: failures.map((error) =>
                    error instanceof Error ? error.message : String(error)),
            }),
        };
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
                    () => this.#instanceChanges.publish("registry"),
                );
            } catch (error) {
                failures.push(error);
                return failures;
            }
        }
        await this.#hooks
            .retireGenerationResources(record.instance)
            .catch((error) => failures.push(error));

        if (failures.length > 0) {
            if (candidate !== undefined) {
                await closeDescriptorResourcesBestEffort(
                    candidate,
                    this.#finalizeRuntimeInstance,
                ).catch((error) => failures.push(error));
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
                    .remove(record.instance.name, candidate, () =>
                        this.#instanceChanges.publish("registry"),
                    )
                    .catch((cleanupError) => failures.push(cleanupError));
                await this.#syncMcpEndpoint(record.instance.name).catch(
                    (cleanupError) => failures.push(cleanupError),
                );
            }
            await closeDescriptorResourcesBestEffort(
                candidate,
                this.#finalizeRuntimeInstance,
            ).catch((cleanupError) => failures.push(cleanupError));
        }
        return failures;
    }

    async #reconcileCleanupRecord(
        record: InstanceCleanupDebtRecord,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        if (record.operation === "delete" &&
            (this.#instanceRegistry.get(record.instance.name) !== undefined ||
                this.#engine.current.instances.some((entry) => entry.name === record.instance.name))) {
            // A controller debt ID does not identify a Worker generation.
            // Never send name-addressed cleanup to a replacement instance.
            return [this.#cleanupConflict(record.instance.name)];
        }
        const descriptor =
            this.#cleanupOnlyDescriptors.get(record.instance.name) ??
            this.#createRuntimeInstance(record.instance);
        this.#cleanupOnlyDescriptors.set(record.instance.name, descriptor);
        if (record.operation === "delete") {
            this.#cleanupOnlyDescriptors.set(record.instance.name, descriptor);
            try {
                if (descriptor.supervision.managementMode === "selfManaged") {
                    await this.#detachContextInstance?.(record.instance.name);
                    await this.reconcileSelfManagedContextCleanup(record.instance.name, descriptor);
                } else {
                    await this.#prepareContextCleanup(record.instance.name, descriptor);
                }
            } catch (error) {
                failures.push(error);
                return failures;
            }
        }
        if (record.operation === "delete") {
            await this.#mcp
                ?.retireMcpApp(record.instance.name)
                .catch((error) => failures.push(error));
        }
        if (!descriptor.lifecycle.retired) {
            await descriptor.retire().catch((error) => failures.push(error));
        }
        await this.#hooks
            .retireGenerationResources(record.instance)
            .catch((error) => failures.push(error));
        let workerRetirementSucceeded = false;
        if (record.operation === "disable") {
            failures.push(
                ...(await this.#hooks.retireDisable(record.instance)),
            );
            await this.#mcp
                ?.retireMcpApp(record.instance.name)
                .catch((error) => failures.push(error));
            try {
                await descriptor.stopWorkerForDisable();
                workerRetirementSucceeded = true;
            } catch (error) {
                failures.push(error);
            }
        } else {
            failures.push(...(await this.#hooks.retireDelete(record.instance)));
            if (record.remoteAbandoned) workerRetirementSucceeded = true;
            else try {
                await descriptor.retireWorkerResources(
                    descriptor.supervision.managementMode === "selfManaged" ||
                        (record.instance.provider !== "local" &&
                            (record.skipRuntimeRetirement === true || !record.instance.enabled)),
                );
                workerRetirementSucceeded = true;
            } catch (error) {
                if (record.instance.provider === "local") failures.push(error);
                else {
                    // Persist the orphan identity before releasing the name.
                    // No later reconciliation may retire a different generation.
                    await this.#cleanupDebts.markRemoteAbandoned(record.instance.name);
                    console.warn(
                        `Remote resource orphan recorded for ${record.instance.name}:`,
                        error,
                    );
                    workerRetirementSucceeded = true;
                }
            }
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
            this.#cleanupOnlyDescriptors.get(record.instance.name) ===
                descriptor
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

function describeDebtFailure(error: unknown): string {
    if (error instanceof AggregateError)
        return [error.message, ...error.errors.map(describeDebtFailure)]
            .filter(Boolean).join(": ");
    return error instanceof Error ? error.message : String(error);
}

/** Display only resource locators, never provider configuration or credentials. */
function cleanupTargetDescription(instance: ControlConfig["instances"][number]): string {
    switch (instance.provider) {
        case "docker":
        case "podman":
            return instance.container.mode === "compose"
                ? "compose " + instance.container.compose.projectName + "/" +
                    instance.container.compose.service
                : "container " + instance.container.containerName;
        case "ssh":
            // ssh.command may contain ProxyCommand, private paths or tokens.
            // Never echo that shell expression into a cleanup status response.
            return "SSH target (inspect the saved instance ssh.command locally)";
        case "reverse":
            return "reverse Worker (enrolled instance name: " + instance.name + ")";
        case "local":
            return "this Control host";
    }
}
