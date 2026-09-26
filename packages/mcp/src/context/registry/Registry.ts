import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createError,
    errorCodes,
    type GoalActivityKind,
    type McpContextEnvironment,
} from "@portable-devshell/shared";

import {
    McpContextExecutionStore,
    type McpContextExecutionRecord,
} from "./Execution.js";

import {
    AUTOMATIC_REENTRY_CLAIM_TTL_MS,
    MCP_CONTEXT_EXECUTION_LEASE_MS,
    defaultMcpContextTerminalHistory,
    defaultMcpContextTtlMs,
    type McpContextAutomaticReentryMode,
    type McpContextAutomaticReentryState,
    type McpContextBinding,
    type McpContextDocument,
    type McpContextEnvironmentCleanup,
    type McpContextEnvironmentBinding,
    type McpContextExternalBinding,
    type McpContextInstanceReference,
    type McpContextMaskedInstance,
    type McpContextRecord,
    type McpContextRegistryOptions,
    type McpContextRemoteInstanceHandle,
    type McpContextStoredRecord,
    type McpContextValidationBinding,
} from "./Model.js";

export {
    MCP_CONTEXT_EXECUTION_LEASE_MS,
    defaultMcpContextTerminalHistory,
    defaultMcpContextTtlMs,
} from "./Model.js";
export type {
    McpContextAutomaticReentryState,
    McpContextBinding,
    McpContextEnvironmentCleanup,
    McpContextEnvironmentBinding,
    McpContextExternalBinding,
    McpContextInstanceReference,
    McpContextMaskedInstance,
    McpContextRecord,
    McpContextRegistryOptions,
    McpContextValidationBinding,
} from "./Model.js";

export class McpContextRegistry {
    readonly #contexts = new Map<string, McpContextStoredRecord>();
    readonly #executionHydrated = new Set<string>();
    readonly #executionStore: McpContextExecutionStore;
    readonly #filePath?: string;
    readonly #idFactory: () => string;
    readonly #maxTerminalContexts: number;
    readonly #now: () => number;
    readonly #persistedExpiresAt = new Map<string, number>();
    readonly #ttlMs: number;
    #initialized = false;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: McpContextRegistryOptions = {}) {
        this.#filePath = options.filePath;
        this.#executionStore = new McpContextExecutionStore(
            options.executionFilePath ??
                contextExecutionFilePath(options.filePath),
        );
        this.#initialized = this.#filePath === undefined;
        this.#idFactory = options.idFactory ?? (() => `ctx-${randomUUID()}`);
        this.#maxTerminalContexts =
            options.maxTerminalContexts ?? defaultMcpContextTerminalHistory;
        this.#now = options.now ?? Date.now;
        this.#ttlMs = options.ttlMs ?? defaultMcpContextTtlMs;
        if (
            !Number.isSafeInteger(this.#maxTerminalContexts) ||
            this.#maxTerminalContexts < 0
        ) {
            throw new Error(
                "MCP context maxTerminalContexts must be a non-negative safe integer.",
            );
        }
        if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
            throw new Error(
                "MCP context ttlMs must be a positive finite number.",
            );
        }
    }

    async initialize(): Promise<void> {
        await this.#run(async () => {
            if (this.#initialized) {
                return;
            }
            await this.#load();
            const previous = cloneContextMap(this.#contexts);
            const expired = this.#expireOverdue(this.#now());
            const compacted = this.#compactTerminalContexts();
            const changed = expired || compacted;
            try {
                if (changed) {
                    await this.#persist();
                }
                this.#initialized = true;
            } catch (error) {
                restoreContextMap(this.#contexts, previous);
                throw error;
            }
        });
    }

    async create(binding: McpContextBinding): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const now = this.#now();
            let ctxId = this.#idFactory();
            while (this.#contexts.has(ctxId)) {
                ctxId = `ctx-${randomUUID()}`;
            }
            const at = new Date(now).toISOString();
            const record: McpContextStoredRecord = {
                ...binding,
                createdAt: at,
                ctxId,
                environments: [
                    {
                        instance: binding.instance,
                        temporaryDirectory: binding.temporaryDirectory,
                        workspace: binding.workspace,
                    },
                ],
                expiresAt: new Date(now + this.#ttlMs).toISOString(),
                lastAccessedAt: at,
                status: "active",
            };
            await this.#mutateAndPersist(() => {
                this.#contexts.set(ctxId, record);
            });
            return cloneRecord(record);
        });
    }

    async bindExternal(
        ctxId: string,
        external: McpContextExternalBinding,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            if (!isCtxId(ctxId) || !isExternalBinding(external)) {
                throw invalidExternalBinding();
            }
            const record = this.#contexts.get(ctxId);
            if (
                record === undefined ||
                record.principal !== binding.principal
            ) {
                throw invalidExternalBinding();
            }
            const now = this.#now();
            if (record.status === "disabled") {
                throw disabledContext(ctxId);
            }
            if (
                record.status === "expired" ||
                Date.parse(record.expiresAt) <= now
            ) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            await this.#mutateAndPersist(() => {
                bindExternalRecord(
                    this.#contexts.values(),
                    record,
                    external,
                    binding.principal,
                );
            });
            return cloneRecord(record);
        });
    }

    async lookupExternal(
        external: McpContextExternalBinding,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            if (!isExternalBinding(external)) {
                throw invalidExternalBinding();
            }
            const matches = this.#externalMatches(external, binding.principal);
            if (matches.length === 0) return undefined;
            if (matches.length !== 1) throw invalidExternalBinding();
            const record = matches[0]!;
            const now = this.#now();
            const snapshot = cloneRecord(record);
            if (
                snapshot.status === "active" &&
                Date.parse(snapshot.expiresAt) <= now
            )
                snapshot.status = "expired";
            return snapshot;
        });
    }

    async resolveExternal(
        external: McpContextExternalBinding,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            if (!isExternalBinding(external)) {
                throw invalidExternalBinding();
            }
            const matches = this.#externalMatches(external, binding.principal);
            if (matches.length !== 1) throw invalidExternalBinding();
            const record = matches[0]!;
            const now = this.#now();
            if (record.status === "disabled") {
                throw disabledContext(record.ctxId);
            }
            if (
                record.status === "expired" ||
                Date.parse(record.expiresAt) <= now
            ) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(record.ctxId, record.expiresAt);
            }
            await this.#touchRecord(record, now);
            return cloneRecord(record);
        });
    }

    async lookup(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            if (!isCtxId(ctxId)) throw invalidContext(ctxId);
            const record = this.#contexts.get(ctxId);
            if (
                record === undefined ||
                record.principal !== binding.principal
            ) {
                throw invalidContext(ctxId);
            }
            const snapshot = cloneRecord(record);
            if (
                snapshot.status === "active" &&
                Date.parse(snapshot.expiresAt) <= this.#now()
            )
                snapshot.status = "expired";
            return snapshot;
        });
    }

    async validateAndTouch(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            if (!isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            const record = this.#contexts.get(ctxId);
            if (record === undefined) {
                throw invalidContext(ctxId);
            }
            const now = this.#now();
            if (record.status === "disabled") {
                throw disabledContext(ctxId);
            }
            if (record.principal !== binding.principal) {
                throw invalidContext(ctxId);
            }
            if (
                record.status === "expired" ||
                Date.parse(record.expiresAt) <= now
            ) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            await this.#touchRecord(record, now);
            return cloneRecord(record);
        });
    }

    async validate(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord> {
        const record = await this.lookup(ctxId, binding);
        if (record.status === "disabled") throw disabledContext(ctxId);
        if (record.status === "expired")
            throw expiredContext(ctxId, record.expiresAt);
        return record;
    }

    async validateForInstance(
        ctxId: string,
        instance: string,
        options: { execution?: boolean } = {},
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            if (!isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            const record = this.#contexts.get(ctxId);
            if (record === undefined) {
                throw invalidContext(ctxId);
            }
            if (record.status === "disabled") {
                throw disabledContext(ctxId);
            }
            const now = this.#now();
            if (
                record.status === "expired" ||
                Date.parse(record.expiresAt) <= now
            ) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            if ((record.maskedInstances ?? []).includes(instance)) {
                throw maskedInstance(ctxId, instance);
            }
            if (contextEnvironment(record, instance) === undefined) {
                throw invalidContext(ctxId);
            }
            if (options.execution === true) this.#hydrateExecution(record);
            return cloneRecord(record);
        });
    }

    async assertInstanceAvailable(
        ctxId: string,
        instance: string,
    ): Promise<void> {
        await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#activeRecord(ctxId);
            if ((record.maskedInstances ?? []).includes(instance)) {
                throw maskedInstance(ctxId, instance);
            }
        });
    }

    async readAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            return automaticReentryState(record, this.#now());
        });
    }

    async suppressAutomaticReentry(
        ctxId: string,
        instance: string,
        reason: string,
        mode: Exclude<
            McpContextAutomaticReentryMode,
            "automatic"
        > = "user_owned",
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const at = new Date(this.#now()).toISOString();
            await this.#mutateAndPersist(() => {
                record.automaticReentryEpoch =
                    (record.automaticReentryEpoch ?? 0) + 1;
                record.automaticReentryMode = mode;
                record.automaticReentrySuppressedAt = at;
                record.automaticReentrySuppressionReason = reason;
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            return automaticReentryState(record, this.#now());
        });
    }

    async resumeAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            await this.#mutateAndPersist(() => {
                record.automaticReentryEpoch =
                    (record.automaticReentryEpoch ?? 0) + 1;
                delete record.automaticReentryMode;
                delete record.automaticReentrySuppressedAt;
                delete record.automaticReentrySuppressionReason;
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            return automaticReentryState(record, this.#now());
        });
    }

    async observeAutomaticReentryActivity(
        ctxId: string,
        instance: string,
        kind: GoalActivityKind,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                kind === "observation" ||
                record.automaticReentryMode !== "user_owned"
            ) {
                return automaticReentryState(record, this.#now());
            }
            await this.#mutateAndPersist(() => {
                record.automaticReentryEpoch =
                    (record.automaticReentryEpoch ?? 0) + 1;
                delete record.automaticReentryMode;
                delete record.automaticReentrySuppressedAt;
                delete record.automaticReentrySuppressionReason;
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            return automaticReentryState(record, this.#now());
        });
    }

    async observeExecutionActivity(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            const previous = cloneStoredRecord(record);
            const clearsClaim =
                record.automaticReentryAttemptedAt === undefined &&
                (record.automaticReentryClaimedAt !== undefined ||
                    record.automaticReentryClaimId !== undefined ||
                    record.automaticReentryInstance !== undefined ||
                    record.automaticReentrySourceId !== undefined ||
                    record.automaticReentrySourceKind !== undefined);
            try {
                record.executionEpoch = (record.executionEpoch ?? 0) + 1;
                record.executionLastActivityAt = new Date(now).toISOString();
                record.executionLeaseUntil = new Date(
                    now + MCP_CONTEXT_EXECUTION_LEASE_MS,
                ).toISOString();
                if (record.automaticReentryAttemptedAt === undefined) {
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                }
                await this.#persistExecution(record, clearsClaim);
            } catch (error) {
                this.#contexts.set(previous.ctxId, previous);
                this.#executionHydrated.delete(previous.ctxId);
                throw error;
            }
            return automaticReentryState(record, now);
        });
    }

    async releaseExecutionActivity(
        ctxId: string,
        instance: string,
        expectedEpoch: number,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            if ((record.executionEpoch ?? 0) !== expectedEpoch) {
                return automaticReentryState(record, now);
            }
            const previous = cloneStoredRecord(record);
            try {
                record.executionEpoch = expectedEpoch + 1;
                delete record.executionLeaseUntil;
                await this.#persistExecution(record, false);
            } catch (error) {
                this.#contexts.set(previous.ctxId, previous);
                this.#executionHydrated.delete(previous.ctxId);
                throw error;
            }
            return automaticReentryState(record, now);
        });
    }

    async markAutomaticReentryAttempted(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            if (
                record.automaticReentrySuppressedAt !== undefined ||
                contextExecutionActive(record, now) ||
                !automaticReentryClaimFresh(record, now) ||
                record.automaticReentryClaimId !== claimId ||
                record.automaticReentryInstance !== instance
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is no longer active.`,
                );
            }
            if (record.automaticReentryAttemptedAt === undefined) {
                await this.#mutateAndPersist(() => {
                    record.automaticReentryAttemptedAt = new Date(
                        now,
                    ).toISOString();
                });
            }
            return automaticReentryState(record, now);
        });
    }

    async markAutomaticReentryAccepted(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            if (
                record.automaticReentrySuppressedAt !== undefined ||
                !automaticReentryClaimFresh(record, now) ||
                record.automaticReentryClaimId !== claimId ||
                record.automaticReentryInstance !== instance
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is no longer active.`,
                );
            }
            await this.#mutateAndPersist(() => {
                record.executionEpoch = (record.executionEpoch ?? 0) + 1;
                record.executionLastActivityAt = new Date(now).toISOString();
                record.executionLeaseUntil = new Date(
                    now + MCP_CONTEXT_EXECUTION_LEASE_MS,
                ).toISOString();
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            this.#persistExecutionBestEffort(record);
            return automaticReentryState(record, now);
        });
    }

    async markAutomaticReentryRejected(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                record.automaticReentryClaimId === claimId &&
                record.automaticReentryInstance === instance
            ) {
                await this.#mutateAndPersist(() => {
                    delete record.automaticReentryAttemptedAt;
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                });
            }
            return automaticReentryState(record, this.#now());
        });
    }

    async claimAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ claimed: boolean; state: McpContextAutomaticReentryState }> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            const freshClaim = automaticReentryClaimFresh(record, now);
            if (
                record.automaticReentrySuppressedAt !== undefined ||
                contextExecutionActive(record, now) ||
                (freshClaim &&
                    (record.automaticReentryClaimId !== claimId ||
                        record.automaticReentryInstance !== instance))
            ) {
                return {
                    claimed: false,
                    state: automaticReentryState(record, now),
                };
            }
            await this.#mutateAndPersist(() => {
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
                record.automaticReentryClaimId = claimId;
                record.automaticReentryClaimedAt = new Date(now).toISOString();
                record.automaticReentryInstance = instance;
            });
            return { claimed: true, state: automaticReentryState(record, now) };
        });
    }

    async bindAutomaticReentrySource(
        ctxId: string,
        instance: string,
        claimId: string,
        sourceKind:
            "goal" | "goal-resume" | "goal-retry" | "task-resume" | "wait",
        sourceId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            if (
                !automaticReentryClaimFresh(record, now) ||
                record.automaticReentryClaimId !== claimId ||
                record.automaticReentryInstance !== instance
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is no longer active.`,
                );
            }
            if (
                record.automaticReentrySourceKind !== undefined &&
                (record.automaticReentrySourceKind !== sourceKind ||
                    record.automaticReentrySourceId !== sourceId)
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is already bound to another source.`,
                );
            }
            if (record.automaticReentrySourceKind === undefined) {
                await this.#mutateAndPersist(() => {
                    record.automaticReentrySourceKind = sourceKind;
                    record.automaticReentrySourceId = sourceId;
                });
            }
            return automaticReentryState(record, now);
        });
    }

    async validateAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ state: McpContextAutomaticReentryState; valid: boolean }> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            const valid =
                record.automaticReentrySuppressedAt === undefined &&
                !contextExecutionActive(record, now) &&
                automaticReentryClaimFresh(record, now) &&
                record.automaticReentryClaimId === claimId &&
                record.automaticReentryInstance === instance;
            return { state: automaticReentryState(record, now), valid };
        });
    }

    async releaseAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                record.automaticReentryClaimId === claimId &&
                record.automaticReentryInstance === instance
            ) {
                if (record.automaticReentryAttemptedAt !== undefined) {
                    throw new Error(
                        `Automatic re-entry claim ${claimId} was already attempted.`,
                    );
                }
                await this.#mutateAndPersist(() => {
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                });
            }
            return automaticReentryState(record, this.#now());
        });
    }

    async clearAutomaticReentryClaim(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance, { execution: true });
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                record.automaticReentryInstance === instance &&
                (record.automaticReentryClaimId !== undefined ||
                    record.automaticReentryClaimedAt !== undefined)
            ) {
                await this.#mutateAndPersist(() => {
                    delete record.automaticReentryAttemptedAt;
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                });
            }
            return automaticReentryState(record, this.#now());
        });
    }

    async listAutomaticReentryClaimsForInstance(instance: string): Promise<
        Array<{
            attempted: boolean;
            claimId: string;
            ctxId: string;
            sourceId?: string;
            sourceKind?:
                "goal" | "goal-resume" | "goal-retry" | "task-resume" | "wait";
        }>
    > {
        return await this.#run(async () => {
            return [...this.#contexts.values()]
                .filter(
                    (record) =>
                        record.automaticReentryInstance === instance &&
                        record.automaticReentryClaimId !== undefined,
                )
                .map((record) => ({
                    attempted: record.automaticReentryAttemptedAt !== undefined,
                    claimId: record.automaticReentryClaimId!,
                    ctxId: record.ctxId,
                    ...(record.automaticReentrySourceId === undefined
                        ? {}
                        : { sourceId: record.automaticReentrySourceId }),
                    ...(record.automaticReentrySourceKind === undefined
                        ? {}
                        : { sourceKind: record.automaticReentrySourceKind }),
                }));
        });
    }

    async detachInstance(instance: string): Promise<McpContextRecord[]> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const affected = [...this.#contexts.values()].filter(
                (record) =>
                    record.environments.some(
                        (environment) => environment.instance === instance,
                    ) ||
                    record.remoteInstanceHandles?.some(
                        (reference) => reference.instance === instance,
                    ) === true,
            );
            if (affected.length === 0) return [];
            await this.#mutateAndPersist(() => {
                for (const record of affected) {
                    record.environments = record.environments.filter(
                        (environment) => environment.instance !== instance,
                    );
                    record.remoteInstanceHandles =
                        record.remoteInstanceHandles?.filter(
                            (reference) => reference.instance !== instance,
                        );
                    if (record.remoteInstanceHandles?.length === 0) {
                        record.remoteInstanceHandles = undefined;
                    }
                    if (record.environments.length === 0) {
                        if (record.status !== "disabled") {
                            record.status = "disabled";
                            record.cleanupPending = true;
                        }
                    }
                }
            });
            return affected.map(cloneRecord);
        });
    }

    async attachEnvironment(
        ctxId: string,
        binding: McpContextEnvironmentBinding,
        external?: {
            bindings: readonly McpContextExternalBinding[];
            principal: string;
        },
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (record.status === "disabled") {
                throw disabledContext(ctxId);
            }
            const now = this.#now();
            if (
                record.status === "expired" ||
                Date.parse(record.expiresAt) <= now
            ) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            if ((record.maskedInstances ?? []).includes(binding.instance)) {
                throw maskedInstance(ctxId, binding.instance);
            }
            if (
                external !== undefined &&
                (record.principal !== external.principal ||
                    external.bindings.some(
                        (candidate) => !isExternalBinding(candidate),
                    ))
            ) {
                throw invalidExternalBinding();
            }
            await this.#mutateAndPersist(() => {
                const index = record.environments.findIndex(
                    (environment) => environment.instance === binding.instance,
                );
                const current =
                    index < 0 ? undefined : record.environments[index];
                if (
                    current?.workspace !== undefined &&
                    binding.workspace !== undefined &&
                    current.workspace !== binding.workspace
                ) {
                    appendEnvironmentCleanup(record, {
                        instance: binding.instance,
                        kind: "alerts",
                        workspace: current.workspace,
                    });
                }
                const next: McpContextEnvironment =
                    binding.workspace === undefined
                        ? { ...(current ?? {}), instance: binding.instance }
                        : {
                              instance: binding.instance,
                              temporaryDirectory: binding.temporaryDirectory,
                              workspace: binding.workspace,
                          };
                if (index < 0) {
                    record.environments.push(next);
                } else {
                    record.environments[index] = next;
                }
                if (
                    record.instance === binding.instance &&
                    binding.workspace !== undefined
                ) {
                    record.workspace = binding.workspace;
                    record.temporaryDirectory = binding.temporaryDirectory;
                }
                if (external !== undefined) {
                    for (const externalBinding of external.bindings) {
                        bindExternalRecord(
                            this.#contexts.values(),
                            record,
                            externalBinding,
                            external.principal,
                        );
                    }
                }
            });
            return cloneRecord(record);
        });
    }

    async detachEnvironment(
        ctxId: string,
        instance: string,
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (record.instance === instance) {
                throw new Error(
                    `Cannot detach primary Context environment ${instance}.`,
                );
            }
            if (
                !record.environments.some(
                    (environment) => environment.instance === instance,
                )
            ) {
                return cloneRecord(record);
            }
            await this.#mutateAndPersist(() => {
                record.environments = record.environments.filter(
                    (environment) => environment.instance !== instance,
                );
            });
            return cloneRecord(record);
        });
    }

    async referenceInstance(
        ctxId: string,
        instance: string,
    ): Promise<McpContextInstanceReference | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#activeRecord(ctxId);
            if ((record.maskedInstances ?? []).includes(instance))
                return undefined;
            if (record.instance === instance) return { current: true };
            const existing = record.remoteInstanceHandles?.find(
                (reference) => reference.instance === instance,
            );
            if (existing !== undefined) {
                return { current: false, handle: existing.handle };
            }
            const handle = `ih-${randomUUID()}`;
            await this.#mutateAndPersist(() => {
                record.remoteInstanceHandles = [
                    ...(record.remoteInstanceHandles ?? []),
                    { handle, instance },
                ];
            });
            return { current: false, handle };
        });
    }

    async resolveRemoteInstanceHandle(
        ctxId: string,
        handle: string,
    ): Promise<string> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#activeRecord(ctxId);
            const reference = record.remoteInstanceHandles?.find(
                (candidate) => candidate.handle === handle,
            );
            if (reference === undefined) throw invalidRemoteHandle(ctxId);
            if ((record.maskedInstances ?? []).includes(reference.instance)) {
                throw maskedInstance(ctxId, reference.instance);
            }
            return reference.instance;
        });
    }

    async maskRemoteInstance(
        ctxId: string,
        handle: string,
    ): Promise<McpContextMaskedInstance> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#activeRecord(ctxId);
            const reference = record.remoteInstanceHandles?.find(
                (candidate) => candidate.handle === handle,
            );
            if (reference === undefined) throw invalidRemoteHandle(ctxId);
            if (reference.instance === record.instance) {
                throw createError({
                    code: errorCodes.mcpContextInvalid,
                    details: { ctxId },
                    message:
                        "The primary instance cannot be masked through environ_remote.",
                    retryable: false,
                });
            }
            const environment = record.environments.find(
                (candidate) => candidate.instance === reference.instance,
            );
            if (
                !(record.maskedInstances ?? []).includes(reference.instance) ||
                environment !== undefined
            ) {
                await this.#mutateAndPersist(() => {
                    if (environment !== undefined) {
                        appendEnvironmentCleanup(record, {
                            instance: reference.instance,
                            kind: "instance_reference",
                        });
                        if (environment.workspace !== undefined) {
                            appendEnvironmentCleanup(record, {
                                instance: reference.instance,
                                kind: "alerts",
                                workspace: environment.workspace,
                            });
                        }
                    }
                    record.maskedInstances = [
                        ...new Set([
                            ...(record.maskedInstances ?? []),
                            reference.instance,
                        ]),
                    ];
                    record.environments = record.environments.filter(
                        (candidate) =>
                            candidate.instance !== reference.instance,
                    );
                });
            }
            return {
                ...(environment === undefined
                    ? {}
                    : { environment: { ...environment } }),
                instance: reference.instance,
            };
        });
    }

    async list(): Promise<McpContextRecord[]> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const now = this.#now();
            return [...this.#contexts.values()]
                .map((record) => cloneRecordForRead(record, now))
                .sort((left, right) =>
                    left.createdAt.localeCompare(right.createdAt),
                );
        });
    }

    async listCleanupPending(): Promise<McpContextRecord[]> {
        return await this.#run(async () => {
            this.#assertInitialized();
            return [...this.#contexts.values()]
                .filter(
                    (record) =>
                        record.cleanupPending === true ||
                        (record.status === "disabled" &&
                            record.cleanupPending === undefined),
                )
                .map(cloneRecord);
        });
    }

    async listEnvironmentCleanup(
        ctxId?: string,
    ): Promise<
        Array<{ cleanup: McpContextEnvironmentCleanup; ctxId: string }>
    > {
        return await this.#run(async () => {
            this.#assertInitialized();
            return [...this.#contexts.values()]
                .filter((record) => ctxId === undefined || record.ctxId === ctxId)
                .flatMap((record) =>
                    (record.pendingEnvironmentCleanup ?? []).map((cleanup) => ({
                        cleanup: cloneEnvironmentCleanup(cleanup),
                        ctxId: record.ctxId,
                    })),
                );
        });
    }

    async recordEnvironmentCleanup(
        ctxId: string,
        cleanup: McpContextEnvironmentCleanup,
    ): Promise<void> {
        await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (parseEnvironmentCleanup(cleanup) === undefined) {
                throw new Error("Invalid Context environment cleanup record.");
            }
            if (
                (record.pendingEnvironmentCleanup ?? []).some((candidate) =>
                    sameEnvironmentCleanup(candidate, cleanup),
                )
            ) {
                return;
            }
            await this.#mutateAndPersist(() => {
                appendEnvironmentCleanup(record, cleanup);
            });
        });
    }

    async disable(ctxId: string): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (
                record.status !== "disabled" ||
                record.cleanupPending === undefined
            ) {
                await this.#mutateAndPersist(() => {
                    record.status = "disabled";
                    record.cleanupPending = true;
                });
            }
            return cloneRecord(record);
        });
    }

    async settleCleanup(ctxId: string): Promise<void> {
        await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (record.status === "active" || record.cleanupPending === false)
                return;
            if ((record.pendingEnvironmentCleanup?.length ?? 0) > 0) {
                throw new Error(
                    `Context ${ctxId} cannot settle terminal cleanup while environment cleanup is pending.`,
                );
            }
            await this.#mutateAndPersist(() => {
                record.cleanupPending = false;
            });
        });
    }

    async settleEnvironmentCleanup(
        ctxId: string,
        cleanup: McpContextEnvironmentCleanup,
    ): Promise<void> {
        await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (
                !(record.pendingEnvironmentCleanup ?? []).some((candidate) =>
                    sameEnvironmentCleanup(candidate, cleanup),
                )
            ) {
                return;
            }
            await this.#mutateAndPersist(() => {
                record.pendingEnvironmentCleanup =
                    record.pendingEnvironmentCleanup?.filter(
                        (candidate) =>
                            !sameEnvironmentCleanup(candidate, cleanup),
                    );
                if (record.pendingEnvironmentCleanup?.length === 0) {
                    record.pendingEnvironmentCleanup = undefined;
                }
            });
        });
    }

    async discard(ctxId: string): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            await this.#mutateAndPersist(() => {
                this.#contexts.delete(ctxId);
            });
            return cloneRecord(record);
        });
    }

    async renewForPrincipal(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (
                record === undefined ||
                !isCtxId(ctxId) ||
                record.principal !== binding.principal
            ) {
                throw invalidContext(ctxId);
            }
            if (record.status === "disabled") {
                throw disabledContext(ctxId);
            }
            if (record.status === "expired" && record.cleanupPending === true) {
                throw expiredContext(ctxId, record.expiresAt);
            }
            const now = this.#now();
            await this.#mutateAndPersist(() => {
                record.status = "active";
                record.lastAccessedAt = new Date(now).toISOString();
                record.expiresAt = new Date(now + this.#ttlMs).toISOString();
            });
            return cloneRecord(record);
        });
    }

    async renew(ctxId: string): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (record.status === "disabled") {
                throw disabledContext(ctxId);
            }
            if (record.status === "expired" && record.cleanupPending === true) {
                throw expiredContext(ctxId, record.expiresAt);
            }
            const now = this.#now();
            await this.#mutateAndPersist(() => {
                record.status = "active";
                record.lastAccessedAt = new Date(now).toISOString();
                record.expiresAt = new Date(now + this.#ttlMs).toISOString();
            });
            return cloneRecord(record);
        });
    }

    async updateWorkerState(
        ctxId: string,
        instance: string,
        binding: Pick<McpContextBinding, "temporaryDirectory" | "workspace">,
    ): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (record.status === "disabled") {
                throw disabledContext(ctxId);
            }
            const now = this.#now();
            if (
                record.status === "expired" ||
                Date.parse(record.expiresAt) <= now
            ) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            const environment = contextEnvironment(record, instance);
            if (environment === undefined) {
                throw invalidContext(ctxId);
            }
            await this.#mutateAndPersist(() => {
                if (
                    environment.workspace !== undefined &&
                    environment.workspace !== binding.workspace
                ) {
                    appendEnvironmentCleanup(record, {
                        instance,
                        kind: "alerts",
                        workspace: environment.workspace,
                    });
                }
                environment.workspace = binding.workspace;
                environment.temporaryDirectory = binding.temporaryDirectory;
                if (record.instance === instance) {
                    record.workspace = binding.workspace;
                    record.temporaryDirectory = binding.temporaryDirectory;
                }
            });
            return cloneRecord(record);
        });
    }

    #activeRecord(ctxId: string): McpContextStoredRecord {
        if (!isCtxId(ctxId)) throw invalidContext(ctxId);
        const record = this.#contexts.get(ctxId);
        if (record === undefined) throw invalidContext(ctxId);
        if (record.status === "disabled") throw disabledContext(ctxId);
        if (
            record.status === "expired" ||
            Date.parse(record.expiresAt) <= this.#now()
        ) {
            throw expiredContext(ctxId, record.expiresAt);
        }
        return record;
    }

    #externalMatches(
        external: McpContextExternalBinding,
        principal: string,
    ): McpContextStoredRecord[] {
        return [...this.#contexts.values()].filter(
            (record) =>
                record.principal === principal &&
                (record.externalBindings ?? []).some((candidate) =>
                    sameExternalBinding(candidate, external),
                ),
        );
    }

    async #mutateAndPersist(mutate: () => void): Promise<void> {
        const previous = cloneContextMap(this.#contexts);
        mutate();
        this.#expireOverdue(this.#now());
        this.#compactTerminalContexts();
        try {
            await this.#persist();
        } catch (error) {
            restoreContextMap(this.#contexts, previous);
            throw error;
        }
    }

    async #touchRecord(
        record: McpContextStoredRecord,
        now: number,
    ): Promise<void> {
        const previous = cloneStoredRecord(record);
        const persistedUntil =
            this.#persistedExpiresAt.get(record.ctxId) ??
            Date.parse(record.expiresAt);
        this.#persistedExpiresAt.set(record.ctxId, persistedUntil);
        record.lastAccessedAt = new Date(now).toISOString();
        record.expiresAt = new Date(now + this.#ttlMs).toISOString();
        if (persistedUntil - now > this.#ttlMs / 2) return;
        try {
            await this.#persist();
        } catch (error) {
            this.#contexts.set(previous.ctxId, previous);
            throw error;
        }
    }

    #hydrateExecution(record: McpContextStoredRecord): void {
        if (this.#executionHydrated.has(record.ctxId)) return;
        const stored = this.#executionStore.read(record.ctxId);
        const currentEpoch = record.executionEpoch ?? 0;
        if (stored !== undefined && stored.executionEpoch > currentEpoch) {
            applyExecutionRecord(record, stored);
        } else if (
            stored === undefined &&
            (record.executionEpoch !== undefined ||
                record.executionLastActivityAt !== undefined ||
                record.executionLeaseUntil !== undefined)
        ) {
            this.#persistExecutionBestEffort(record);
        } else if (
            stored !== undefined &&
            currentEpoch > stored.executionEpoch
        ) {
            this.#persistExecutionBestEffort(record);
        }
        this.#executionHydrated.add(record.ctxId);
    }

    async #persistExecution(
        record: McpContextStoredRecord,
        persistStructural: boolean,
    ): Promise<void> {
        try {
            this.#executionStore.write(record.ctxId, executionRecord(record));
            this.#executionHydrated.add(record.ctxId);
        } catch {
            await this.#persist();
            return;
        }
        if (persistStructural) await this.#persist();
    }

    #persistExecutionBestEffort(record: McpContextStoredRecord): void {
        try {
            this.#executionStore.write(record.ctxId, executionRecord(record));
            this.#executionHydrated.add(record.ctxId);
        } catch {
            /**
             * @compat mcp-context-execution-sidecar-fallback
             * @removeAt 0.7.10
             */
            // The main Context document remains a durable compatibility fallback.
        }
    }

    async #load(): Promise<void> {
        if (this.#filePath === undefined) {
            return;
        }
        let raw: string;
        try {
            raw = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if (isMissing(error)) {
                return;
            }
            throw error;
        }
        const parsed = JSON.parse(raw) as unknown;
        if (!isDocument(parsed)) {
            throw new Error(`Invalid MCP context registry: ${this.#filePath}`);
        }
        this.#contexts.clear();
        for (const value of parsed.contexts) {
            const record = parseRecord(value);
            if (record !== undefined) {
                this.#contexts.set(record.ctxId, record);
                continue;
            }
            if (hasLifecycleCleanupState(value)) {
                throw new Error(
                    `Invalid MCP context registry cleanup state: ${this.#filePath}`,
                );
            }
        }
    }

    #expireOverdue(now: number): boolean {
        let changed = false;
        for (const record of this.#contexts.values()) {
            if (
                record.status === "active" &&
                Date.parse(record.expiresAt) <= now
            ) {
                record.status = "expired";
                changed = true;
            }
        }
        return changed;
    }

    #compactTerminalContexts(): boolean {
        const terminal = [...this.#contexts.values()]
            .filter((record) => record.status !== "active")
            .sort((left, right) => {
                const created = left.createdAt.localeCompare(right.createdAt);
                return created === 0
                    ? left.ctxId.localeCompare(right.ctxId)
                    : created;
            });
        let changed = false;
        const overflow = Math.max(
            0,
            terminal.length - this.#maxTerminalContexts,
        );
        for (const record of terminal.slice(0, overflow)) {
            if (record.cleanupPending === false) {
                this.#contexts.delete(record.ctxId);
                this.#executionHydrated.delete(record.ctxId);
                this.#executionStore.delete(record.ctxId);
                changed = true;
                continue;
            }
            if (record.cleanupPending !== true) {
                record.cleanupPending = true;
                changed = true;
            }
        }
        return changed;
    }

    async #persist(): Promise<void> {
        if (this.#filePath === undefined) {
            return;
        }
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const document: McpContextDocument = {
            contexts: [...this.#contexts.values()].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            ),
            version: 1,
        };
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(`${JSON.stringify(document)}\n`, "utf8");
            await file.sync();
        } catch (error) {
            await file.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        await file.close();
        try {
            await rename(temporary, this.#filePath);
            if (process.platform !== "win32") {
                const parent = await open(directory, "r");
                try {
                    await parent.sync();
                } finally {
                    await parent.close();
                }
            }
            for (const record of document.contexts) {
                this.#persistedExpiresAt.set(
                    record.ctxId,
                    Date.parse(record.expiresAt),
                );
            }
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    #assertInitialized(): void {
        if (!this.#initialized) {
            throw new Error("MCP context registry is not initialized.");
        }
    }

    async #run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.#operation.then(operation, operation);
        this.#operation = result.then(
            () => undefined,
            () => undefined,
        );
        return await result;
    }
}

function invalidContext(ctxId: string) {
    return createError({
        code: errorCodes.mcpContextInvalid,
        details: { ctxId },
        message: "ctxId is invalid for the current environment.",
        retryable: false,
    });
}

function invalidRemoteHandle(ctxId: string) {
    return createError({
        code: errorCodes.mcpContextInvalid,
        details: { ctxId },
        message:
            "Remote instance handle is invalid for the current Context. Obtain a current handle with devshell instance list or status.",
        retryable: false,
    });
}

function maskedInstance(ctxId: string, instance: string) {
    return createError({
        code: errorCodes.mcpContextInstanceMasked,
        details: { ctxId, instance },
        message:
            "This remote instance is permanently masked for the lifetime of the current Context.",
        retryable: false,
    });
}

function invalidExternalBinding() {
    return createError({
        code: errorCodes.mcpContextInvalid,
        message: "No valid Context is bound to the current external identity.",
        retryable: false,
    });
}

function expiredContext(ctxId: string, expiresAt: string) {
    return createError({
        code: errorCodes.mcpContextExpired,
        details: { ctxId, expiresAt },
        message:
            "ctxId lease has expired. Call environ_info to reactivate the same Context.",
        retryable: false,
    });
}

function disabledContext(ctxId: string) {
    return createError({
        code: errorCodes.mcpContextDisabled,
        details: { ctxId },
        message:
            "ctxId is disabled and cannot be reactivated. Call environ_info with workspace to establish a new active Context.",
        retryable: false,
    });
}

function isCtxId(value: string): boolean {
    return value.startsWith("ctx-") && value.length > 4;
}

function cloneRecord(record: McpContextStoredRecord): McpContextRecord {
    const {
        cleanupPending: _cleanupPending,
        executionEpoch: _executionEpoch,
        executionLastActivityAt: _executionLastActivityAt,
        executionLeaseUntil: _executionLeaseUntil,
        automaticReentryAttemptedAt: _automaticReentryAttemptedAt,
        automaticReentryClaimedAt: _automaticReentryClaimedAt,
        automaticReentryClaimId: _automaticReentryClaimId,
        automaticReentryInstance: _automaticReentryInstance,
        automaticReentryEpoch: _automaticReentryEpoch,
        automaticReentrySuppressedAt: _automaticReentrySuppressedAt,
        automaticReentrySuppressionReason: _automaticReentrySuppressionReason,
        automaticReentrySourceId: _automaticReentrySourceId,
        automaticReentrySourceKind: _automaticReentrySourceKind,
        externalBindings: _externalBindings,
        maskedInstances: _maskedInstances,
        pendingEnvironmentCleanup: _pendingEnvironmentCleanup,
        remoteInstanceHandles: _remoteInstanceHandles,
        ...publicRecord
    } = record;
    return {
        ...publicRecord,
        environments: record.environments.map((environment) => ({
            ...environment,
        })),
    };
}

function cloneRecordForRead(
    record: McpContextStoredRecord,
    now: number,
): McpContextRecord {
    const cloned = cloneRecord(record);
    return cloned.status === "active" && Date.parse(cloned.expiresAt) <= now
        ? { ...cloned, status: "expired" }
        : cloned;
}

function cloneStoredRecord(
    record: McpContextStoredRecord,
): McpContextStoredRecord {
    return {
        ...record,
        externalBindings: record.externalBindings?.map((binding) => ({
            ...binding,
        })),
        maskedInstances:
            record.maskedInstances === undefined
                ? undefined
                : [...record.maskedInstances],
        pendingEnvironmentCleanup: record.pendingEnvironmentCleanup?.map(
            cloneEnvironmentCleanup,
        ),
        remoteInstanceHandles: record.remoteInstanceHandles?.map(
            (reference) => ({ ...reference }),
        ),
        environments: record.environments.map((environment) => ({
            ...environment,
        })),
    };
}

function contextEnvironment(
    record: McpContextRecord,
    instance: string,
): McpContextEnvironment | undefined {
    return record.environments.find(
        (environment) => environment.instance === instance,
    );
}

function cloneContextMap(
    contexts: ReadonlyMap<string, McpContextStoredRecord>,
): Map<string, McpContextStoredRecord> {
    return new Map(
        [...contexts].map(([ctxId, record]) => [
            ctxId,
            cloneStoredRecord(record),
        ]),
    );
}

function restoreContextMap(
    contexts: Map<string, McpContextStoredRecord>,
    previous: ReadonlyMap<string, McpContextStoredRecord>,
): void {
    contexts.clear();
    for (const [ctxId, record] of previous) {
        contexts.set(ctxId, cloneStoredRecord(record));
    }
}

function isDocument(value: unknown): value is McpContextDocument {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { version?: unknown }).version === 1 &&
        Array.isArray((value as { contexts?: unknown }).contexts)
    );
}

/**
 * @compat mcp-context-v1-fields
 * @removeAt 0.7.10
 */
function parseRecord(value: unknown): McpContextStoredRecord | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const record = value as Partial<McpContextStoredRecord>;
    const status = raw.status;
    const parsedBindings = Array.isArray(record.externalBindings)
        ? record.externalBindings.map(parseExternalBinding)
        : [];
    if (parsedBindings.some((binding) => binding === undefined))
        return undefined;
    const legacySelectorValue = raw.externalSelector;
    const legacySelector = parseExternalBinding(legacySelectorValue);
    if (legacySelectorValue !== undefined && legacySelector === undefined) {
        return undefined;
    }
    const legacyOpenAiSessionId = raw.openAiSessionId;
    if (
        legacyOpenAiSessionId !== undefined &&
        (typeof legacyOpenAiSessionId !== "string" ||
            legacyOpenAiSessionId.length === 0)
    ) {
        return undefined;
    }
    const legacyOpenAiSession =
        typeof legacyOpenAiSessionId === "string"
            ? { kind: "openai/session", value: legacyOpenAiSessionId }
            : undefined;
    const externalBindings = uniqueExternalBindings([
        ...(parsedBindings as McpContextExternalBinding[]),
        ...(legacySelector === undefined ? [] : [legacySelector]),
        ...(legacyOpenAiSession === undefined ? [] : [legacyOpenAiSession]),
    ]);
    const remoteInstanceHandles = Array.isArray(raw.remoteInstanceHandles)
        ? raw.remoteInstanceHandles.map(parseRemoteInstanceHandle)
        : [];
    if (remoteInstanceHandles.some((reference) => reference === undefined))
        return undefined;
    const maskedInstances = Array.isArray(raw.maskedInstances)
        ? raw.maskedInstances.map((instance) =>
              typeof instance === "string" && instance.length > 0
                  ? instance
                  : undefined,
          )
        : [];
    if (maskedInstances.some((instance) => instance === undefined))
        return undefined;
    if (
        raw.pendingEnvironmentCleanup !== undefined &&
        !Array.isArray(raw.pendingEnvironmentCleanup)
    ) {
        throw new Error("Invalid MCP Context environment cleanup state.");
    }
    const pendingEnvironmentCleanup =
        raw.pendingEnvironmentCleanup?.map(parseEnvironmentCleanup) ?? [];
    if (pendingEnvironmentCleanup.some((cleanup) => cleanup === undefined)) {
        throw new Error("Invalid MCP Context environment cleanup state.");
    }
    if (
        typeof record.ctxId !== "string" ||
        !isCtxId(record.ctxId) ||
        typeof record.principal !== "string" ||
        typeof record.instance !== "string" ||
        typeof record.workspace !== "string" ||
        typeof record.createdAt !== "string" ||
        typeof record.lastAccessedAt !== "string" ||
        typeof record.expiresAt !== "string" ||
        (record.temporaryDirectory !== undefined &&
            typeof record.temporaryDirectory !== "string") ||
        (raw.cleanupPending !== undefined &&
            typeof raw.cleanupPending !== "boolean") ||
        (status !== "active" && status !== "expired" && status !== "disabled")
    ) {
        return undefined;
    }
    const hasStoredEnvironments = Array.isArray(record.environments);
    const environments = hasStoredEnvironments
        ? record.environments!.map(parseEnvironment)
        : [];
    if (environments.some((environment) => environment === undefined)) {
        return undefined;
    }
    const byInstance = new Map<string, McpContextEnvironment>();
    for (const environment of environments as McpContextEnvironment[]) {
        byInstance.set(environment.instance, environment);
    }
    if (!hasStoredEnvironments) {
        byInstance.set(record.instance, {
            instance: record.instance,
            temporaryDirectory: record.temporaryDirectory,
            workspace: record.workspace,
        });
    }
    const automaticReentryInstance =
        typeof raw.automaticReentryInstance === "string" &&
        byInstance.has(raw.automaticReentryInstance)
            ? raw.automaticReentryInstance
            : undefined;
    return {
        ...(raw.cleanupPending === undefined
            ? {}
            : { cleanupPending: raw.cleanupPending as boolean }),
        ...(typeof raw.executionEpoch === "number" &&
        Number.isSafeInteger(raw.executionEpoch) &&
        raw.executionEpoch >= 0
            ? { executionEpoch: raw.executionEpoch }
            : {}),
        ...(typeof raw.executionLastActivityAt === "string" &&
        raw.executionLastActivityAt.length > 0
            ? { executionLastActivityAt: raw.executionLastActivityAt }
            : {}),
        ...(typeof raw.executionLeaseUntil === "string" &&
        raw.executionLeaseUntil.length > 0
            ? { executionLeaseUntil: raw.executionLeaseUntil }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentryAttemptedAt === "string" &&
        raw.automaticReentryAttemptedAt.length > 0
            ? { automaticReentryAttemptedAt: raw.automaticReentryAttemptedAt }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentryClaimedAt === "string" &&
        raw.automaticReentryClaimedAt.length > 0
            ? { automaticReentryClaimedAt: raw.automaticReentryClaimedAt }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentryClaimId === "string" &&
        raw.automaticReentryClaimId.length > 0
            ? { automaticReentryClaimId: raw.automaticReentryClaimId }
            : {}),
        ...(automaticReentryInstance === undefined
            ? {}
            : { automaticReentryInstance }),
        ...(typeof raw.automaticReentryEpoch === "number" &&
        Number.isSafeInteger(raw.automaticReentryEpoch) &&
        raw.automaticReentryEpoch >= 0
            ? { automaticReentryEpoch: raw.automaticReentryEpoch }
            : {}),
        ...(raw.automaticReentryMode === "user_owned" ||
        raw.automaticReentryMode === "paused"
            ? { automaticReentryMode: raw.automaticReentryMode }
            : {}),
        ...(typeof raw.automaticReentrySuppressedAt === "string" &&
        raw.automaticReentrySuppressedAt.length > 0
            ? { automaticReentrySuppressedAt: raw.automaticReentrySuppressedAt }
            : {}),
        ...(typeof raw.automaticReentrySuppressionReason === "string" &&
        raw.automaticReentrySuppressionReason.length > 0
            ? {
                  automaticReentrySuppressionReason:
                      raw.automaticReentrySuppressionReason,
              }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentrySourceId === "string" &&
        raw.automaticReentrySourceId.length > 0
            ? { automaticReentrySourceId: raw.automaticReentrySourceId }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        (raw.automaticReentrySourceKind === "goal" ||
            raw.automaticReentrySourceKind === "goal-resume" ||
            raw.automaticReentrySourceKind === "goal-retry" ||
            raw.automaticReentrySourceKind === "task-resume" ||
            raw.automaticReentrySourceKind === "wait")
            ? { automaticReentrySourceKind: raw.automaticReentrySourceKind }
            : {}),
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        environments: [...byInstance.values()],
        ...(externalBindings.length === 0 ? {} : { externalBindings }),
        ...(maskedInstances.length === 0
            ? {}
            : { maskedInstances: [...new Set(maskedInstances as string[])] }),
        ...(pendingEnvironmentCleanup.length === 0
            ? {}
            : {
                  pendingEnvironmentCleanup:
                      pendingEnvironmentCleanup as McpContextEnvironmentCleanup[],
              }),
        ...(remoteInstanceHandles.length === 0
            ? {}
            : {
                  remoteInstanceHandles:
                      remoteInstanceHandles as McpContextRemoteInstanceHandle[],
              }),
        expiresAt: record.expiresAt,
        instance: record.instance,
        lastAccessedAt: record.lastAccessedAt,
        principal: record.principal,
        status: status as "active" | "expired" | "disabled",
        temporaryDirectory: record.temporaryDirectory,
        workspace: record.workspace,
    };
}

function hasLifecycleCleanupState(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        record.cleanupPending === true ||
        record.pendingEnvironmentCleanup !== undefined
    );
}

function parseRemoteInstanceHandle(
    value: unknown,
): McpContextRemoteInstanceHandle | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const handle = (value as { handle?: unknown }).handle;
    const instance = (value as { instance?: unknown }).instance;
    return typeof handle === "string" &&
        handle.startsWith("ih-") &&
        handle.length > 3 &&
        typeof instance === "string" &&
        instance.length > 0
        ? { handle, instance }
        : undefined;
}

function parseEnvironmentCleanup(
    value: unknown,
): McpContextEnvironmentCleanup | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const cleanup = value as Record<string, unknown>;
    if (
        typeof cleanup.instance !== "string" ||
        cleanup.instance.length === 0
    ) {
        return undefined;
    }
    if (cleanup.kind === "instance_reference") {
        return {
            instance: cleanup.instance,
            kind: "instance_reference",
        };
    }
    if (
        cleanup.kind === "alerts" &&
        typeof cleanup.workspace === "string" &&
        cleanup.workspace.length > 0
    ) {
        return {
            instance: cleanup.instance,
            kind: "alerts",
            workspace: cleanup.workspace,
        };
    }
    return undefined;
}

function cloneEnvironmentCleanup(
    cleanup: McpContextEnvironmentCleanup,
): McpContextEnvironmentCleanup {
    return { ...cleanup };
}

function sameEnvironmentCleanup(
    left: McpContextEnvironmentCleanup,
    right: McpContextEnvironmentCleanup,
): boolean {
    return (
        left.kind === right.kind &&
        left.instance === right.instance &&
        (left.kind !== "alerts" ||
            (right.kind === "alerts" && left.workspace === right.workspace))
    );
}

function appendEnvironmentCleanup(
    record: McpContextStoredRecord,
    cleanup: McpContextEnvironmentCleanup,
): void {
    if (
        (record.pendingEnvironmentCleanup ?? []).some((candidate) =>
            sameEnvironmentCleanup(candidate, cleanup),
        )
    ) {
        return;
    }
    record.pendingEnvironmentCleanup = [
        ...(record.pendingEnvironmentCleanup ?? []),
        cloneEnvironmentCleanup(cleanup),
    ];
}

function automaticReentryState(
    record: McpContextStoredRecord,
    now = Date.now(),
): McpContextAutomaticReentryState {
    const pending = automaticReentryClaimFresh(record, now);
    return {
        attempted:
            record.automaticReentryInstance !== undefined &&
            record.automaticReentryAttemptedAt !== undefined,
        ...(pending && record.automaticReentryClaimId !== undefined
            ? { claimId: record.automaticReentryClaimId }
            : {}),
        epoch: record.automaticReentryEpoch ?? 0,
        executionActive: contextExecutionActive(record, now),
        executionEpoch: record.executionEpoch ?? 0,
        ...(record.executionLastActivityAt === undefined
            ? {}
            : { executionLastActivityAt: record.executionLastActivityAt }),
        ...(record.executionLeaseUntil === undefined
            ? {}
            : { executionLeaseUntil: record.executionLeaseUntil }),
        mode: record.automaticReentryMode ?? "automatic",
        pending,
        ...(record.automaticReentrySuppressedAt === undefined
            ? {}
            : { suppressedAt: record.automaticReentrySuppressedAt }),
        ...(record.automaticReentrySuppressionReason === undefined
            ? {}
            : { reason: record.automaticReentrySuppressionReason }),
        ...(record.automaticReentrySourceId === undefined
            ? {}
            : { sourceId: record.automaticReentrySourceId }),
        ...(record.automaticReentrySourceKind === undefined
            ? {}
            : { sourceKind: record.automaticReentrySourceKind }),
    };
}

function applyExecutionRecord(
    record: McpContextStoredRecord,
    execution: McpContextExecutionRecord,
): void {
    record.executionEpoch = execution.executionEpoch;
    if (execution.executionLastActivityAt === undefined)
        delete record.executionLastActivityAt;
    else record.executionLastActivityAt = execution.executionLastActivityAt;
    if (execution.executionLeaseUntil === undefined)
        delete record.executionLeaseUntil;
    else record.executionLeaseUntil = execution.executionLeaseUntil;
}

function executionRecord(
    record: McpContextStoredRecord,
): McpContextExecutionRecord {
    return {
        executionEpoch: record.executionEpoch ?? 0,
        ...(record.executionLastActivityAt === undefined
            ? {}
            : { executionLastActivityAt: record.executionLastActivityAt }),
        ...(record.executionLeaseUntil === undefined
            ? {}
            : { executionLeaseUntil: record.executionLeaseUntil }),
    };
}

function contextExecutionFilePath(
    filePath: string | undefined,
): string | undefined {
    if (filePath === undefined) return undefined;
    return filePath.endsWith(".json")
        ? `${filePath.slice(0, -5)}.activity.sqlite3`
        : `${filePath}.activity.sqlite3`;
}

function contextExecutionActive(
    record: McpContextStoredRecord,
    now: number,
): boolean {
    if (record.executionLeaseUntil === undefined) return false;
    const leaseUntil = Date.parse(record.executionLeaseUntil);
    return Number.isFinite(leaseUntil) && now < leaseUntil;
}

function automaticReentryClaimFresh(
    record: McpContextStoredRecord,
    now: number,
): boolean {
    if (
        record.automaticReentryInstance === undefined ||
        record.automaticReentryClaimId === undefined ||
        record.automaticReentryClaimedAt === undefined
    )
        return false;
    if (record.automaticReentryAttemptedAt !== undefined) return true;
    const claimedAt = Date.parse(record.automaticReentryClaimedAt);
    return (
        Number.isFinite(claimedAt) &&
        now - claimedAt < AUTOMATIC_REENTRY_CLAIM_TTL_MS
    );
}

function parseExternalBinding(
    value: unknown,
): McpContextExternalBinding | undefined {
    return isExternalBinding(value) ? { ...value } : undefined;
}

function isExternalBinding(value: unknown): value is McpContextExternalBinding {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const binding = value as Partial<McpContextExternalBinding>;
    return (
        typeof binding.kind === "string" &&
        binding.kind.length > 0 &&
        typeof binding.value === "string" &&
        binding.value.length > 0
    );
}

function sameExternalBinding(
    left: McpContextExternalBinding,
    right: McpContextExternalBinding,
): boolean {
    return left.kind === right.kind && left.value === right.value;
}

function bindExternalRecord(
    contexts: Iterable<McpContextStoredRecord>,
    record: McpContextStoredRecord,
    external: McpContextExternalBinding,
    principal: string,
): void {
    for (const existing of contexts) {
        if (existing.principal !== principal) continue;
        existing.externalBindings = (existing.externalBindings ?? []).filter(
            (candidate) => !sameExternalBinding(candidate, external),
        );
        if (existing.externalBindings.length === 0) {
            existing.externalBindings = undefined;
        }
    }
    record.externalBindings = [
        ...(record.externalBindings ?? []),
        { ...external },
    ];
}

function uniqueExternalBindings(
    bindings: McpContextExternalBinding[],
): McpContextExternalBinding[] {
    const unique = new Map<string, McpContextExternalBinding>();
    for (const binding of bindings) {
        unique.set(`${binding.kind}\0${binding.value}`, binding);
    }
    return [...unique.values()];
}

function parseEnvironment(value: unknown): McpContextEnvironment | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const environment = value as Partial<McpContextEnvironment>;
    if (
        typeof environment.instance !== "string" ||
        environment.instance.length === 0 ||
        (environment.workspace !== undefined &&
            typeof environment.workspace !== "string") ||
        (environment.temporaryDirectory !== undefined &&
            typeof environment.temporaryDirectory !== "string")
    ) {
        return undefined;
    }
    return {
        instance: environment.instance,
        temporaryDirectory: environment.temporaryDirectory,
        workspace: environment.workspace,
    };
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
    );
}
