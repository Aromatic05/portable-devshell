import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createError,
    errorCodes,
    type McpContextEnvironment,
    type McpContextRecord,
} from "@portable-devshell/shared";

export type { McpContextRecord } from "@portable-devshell/shared";

export const defaultMcpContextTtlMs = 24 * 60 * 60 * 1_000;
export const defaultMcpContextTerminalHistory = 256;

export interface McpContextBinding {
    instance: string;
    principal: string;
    temporaryDirectory?: string;
    workspace: string;
}

export interface McpContextEnvironmentBinding {
    instance: string;
    temporaryDirectory?: string;
    workspace?: string;
}

export interface McpContextValidationBinding {
    principal: string;
}

export interface McpContextExternalBinding {
    kind: string;
    value: string;
}

interface McpContextStoredRecord extends McpContextRecord {
    automaticReentryClaimedAt?: string;
    automaticReentryClaimId?: string;
    automaticReentryEpoch?: number;
    automaticReentrySuppressedAt?: string;
    automaticReentrySuppressionReason?: string;
    externalBindings?: McpContextExternalBinding[];
}

export interface McpContextAutomaticReentryState {
    claimId?: string;
    epoch: number;
    pending: boolean;
    reason?: string;
    suppressedAt?: string;
}

const AUTOMATIC_REENTRY_CLAIM_TTL_MS = 2 * 60_000;

interface McpContextDocument {
    contexts: McpContextStoredRecord[];
    version: 1;
}

export interface McpContextRegistryOptions {
    filePath?: string;
    idFactory?: () => string;
    maxTerminalContexts?: number;
    now?: () => number;
    ttlMs?: number;
}

export class McpContextRegistry {
    readonly #contexts = new Map<string, McpContextStoredRecord>();
    readonly #filePath?: string;
    readonly #idFactory: () => string;
    readonly #maxTerminalContexts: number;
    readonly #now: () => number;
    readonly #ttlMs: number;
    #initialized = false;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: McpContextRegistryOptions = {}) {
        this.#filePath = options.filePath;
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
                for (const existing of this.#contexts.values()) {
                    if (existing.principal !== binding.principal) continue;
                    existing.externalBindings = (
                        existing.externalBindings ?? []
                    ).filter(
                        (candidate) =>
                            !sameExternalBinding(candidate, external),
                    );
                    if (existing.externalBindings.length === 0) {
                        existing.externalBindings = undefined;
                    }
                }
                record.externalBindings = [
                    ...(record.externalBindings ?? []),
                    { ...external },
                ];
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
            if (
                record.status === "active" &&
                Date.parse(record.expiresAt) <= now
            ) {
                await this.#mutateAndPersist(() => {
                    record.status = "expired";
                });
            }
            return cloneRecord(record);
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
            await this.#mutateAndPersist(() => {
                record.lastAccessedAt = new Date(now).toISOString();
                record.expiresAt = new Date(now + this.#ttlMs).toISOString();
            });
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
            const now = this.#now();
            if (
                record.status === "active" &&
                Date.parse(record.expiresAt) <= now
            ) {
                await this.#mutateAndPersist(() => {
                    record.status = "expired";
                });
            }
            return cloneRecord(record);
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
            await this.#mutateAndPersist(() => {
                record.lastAccessedAt = new Date(now).toISOString();
                record.expiresAt = new Date(now + this.#ttlMs).toISOString();
            });
            return cloneRecord(record);
        });
    }

    async validate(
        ctxId: string,
        binding: McpContextValidationBinding,
    ): Promise<McpContextRecord> {
        const record = await this.lookup(ctxId, binding);
        if (record.status === "disabled") throw disabledContext(ctxId);
        if (record.status === "expired") throw expiredContext(ctxId, record.expiresAt);
        return record;
    }

    async validateForInstance(
        ctxId: string,
        instance: string,
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
            if (contextEnvironment(record, instance) === undefined) {
                throw invalidContext(ctxId);
            }
            return cloneRecord(record);
        });
    }

    async readAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance);
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            return automaticReentryState(record);
        });
    }

    async suppressAutomaticReentry(
        ctxId: string,
        instance: string,
        reason: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance);
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const at = new Date(this.#now()).toISOString();
            await this.#mutateAndPersist(() => {
                record.automaticReentryEpoch = (record.automaticReentryEpoch ?? 0) + 1;
                record.automaticReentrySuppressedAt = at;
                record.automaticReentrySuppressionReason = reason;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
            });
            return automaticReentryState(record);
        });
    }

    async resumeAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance);
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            await this.#mutateAndPersist(() => {
                record.automaticReentryEpoch = (record.automaticReentryEpoch ?? 0) + 1;
                delete record.automaticReentrySuppressedAt;
                delete record.automaticReentrySuppressionReason;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
            });
            return automaticReentryState(record);
        });
    }

    async claimAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ claimed: boolean; state: McpContextAutomaticReentryState }> {
        await this.validateForInstance(ctxId, instance);
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            const freshClaim = automaticReentryClaimFresh(record, now);
            if (record.automaticReentrySuppressedAt !== undefined || (freshClaim && record.automaticReentryClaimId !== claimId)) {
                return { claimed: false, state: automaticReentryState(record, now) };
            }
            await this.#mutateAndPersist(() => {
                record.automaticReentryClaimId = claimId;
                record.automaticReentryClaimedAt = new Date(now).toISOString();
            });
            return { claimed: true, state: automaticReentryState(record, now) };
        });
    }

    async validateAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ state: McpContextAutomaticReentryState; valid: boolean }> {
        await this.validateForInstance(ctxId, instance);
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#now();
            const valid = record.automaticReentrySuppressedAt === undefined &&
                automaticReentryClaimFresh(record, now) && record.automaticReentryClaimId === claimId;
            return { state: automaticReentryState(record, now), valid };
        });
    }

    async releaseAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance);
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (record.automaticReentryClaimId === claimId) {
                await this.#mutateAndPersist(() => {
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                });
            }
            return automaticReentryState(record);
        });
    }

    async clearAutomaticReentryClaim(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.validateForInstance(ctxId, instance);
        return await this.#run(async () => {
            const record = this.#contexts.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (record.automaticReentryClaimId !== undefined || record.automaticReentryClaimedAt !== undefined) {
                await this.#mutateAndPersist(() => {
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                });
            }
            return automaticReentryState(record);
        });
    }

    async detachInstance(instance: string): Promise<McpContextRecord[]> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const affected = [...this.#contexts.values()].filter((record) =>
                record.environments.some((environment) => environment.instance === instance),
            );
            if (affected.length === 0) return [];
            await this.#mutateAndPersist(() => {
                for (const record of affected) {
                    record.environments = record.environments.filter(
                        (environment) => environment.instance !== instance,
                    );
                    if (record.environments.length === 0) {
                        record.status = "disabled";
                    }
                }
            });
            return affected.map(cloneRecord);
        });
    }

    async attachEnvironment(
        ctxId: string,
        binding: McpContextEnvironmentBinding,
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
            await this.#mutateAndPersist(() => {
                const index = record.environments.findIndex(
                    (environment) => environment.instance === binding.instance,
                );
                const current =
                    index < 0 ? undefined : record.environments[index];
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
            });
            return cloneRecord(record);
        });
    }

    async list(): Promise<McpContextRecord[]> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const previous = cloneContextMap(this.#contexts);
            const expired = this.#expireOverdue(this.#now());
            const compacted = this.#compactTerminalContexts();
            if (expired || compacted) {
                try {
                    await this.#persist();
                } catch (error) {
                    restoreContextMap(this.#contexts, previous);
                    throw error;
                }
            }
            return [...this.#contexts.values()]
                .map(cloneRecord)
                .sort((left, right) =>
                    left.createdAt.localeCompare(right.createdAt),
                );
        });
    }

    async disable(ctxId: string): Promise<McpContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            await this.#mutateAndPersist(() => {
                record.status = "disabled";
            });
            return cloneRecord(record);
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
        this.#compactTerminalContexts();
        try {
            await this.#persist();
        } catch (error) {
            restoreContextMap(this.#contexts, previous);
            throw error;
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
        while (terminal.length > this.#maxTerminalContexts) {
            const record = terminal.shift()!;
            this.#contexts.delete(record.ctxId);
            changed = true;
        }
        return changed;
    }

    async #persist(): Promise<void> {
        if (this.#filePath === undefined) {
            return;
        }
        await mkdir(dirname(this.#filePath), { recursive: true });
        const document: McpContextDocument = {
            contexts: [...this.#contexts.values()].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            ),
            version: 1,
        };
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(
                temporary,
                `${JSON.stringify(document, null, 2)}\n`,
                { encoding: "utf8", mode: 0o600 },
            );
            await rename(temporary, this.#filePath);
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
        automaticReentryClaimedAt: _automaticReentryClaimedAt,
        automaticReentryClaimId: _automaticReentryClaimId,
        automaticReentryEpoch: _automaticReentryEpoch,
        automaticReentrySuppressedAt: _automaticReentrySuppressedAt,
        automaticReentrySuppressionReason: _automaticReentrySuppressionReason,
        externalBindings: _externalBindings,
        ...publicRecord
    } = record;
    return {
        ...publicRecord,
        environments: record.environments.map((environment) => ({
            ...environment,
        })),
    };
}

function cloneStoredRecord(
    record: McpContextStoredRecord,
): McpContextStoredRecord {
    return {
        ...record,
        externalBindings: record.externalBindings?.map((binding) => ({
            ...binding,
        })),
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
        (typeof legacyOpenAiSessionId !== "string" || legacyOpenAiSessionId.length === 0)
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
    return {
        ...(typeof raw.automaticReentryClaimedAt === "string" && raw.automaticReentryClaimedAt.length > 0
            ? { automaticReentryClaimedAt: raw.automaticReentryClaimedAt }
            : {}),
        ...(typeof raw.automaticReentryClaimId === "string" && raw.automaticReentryClaimId.length > 0
            ? { automaticReentryClaimId: raw.automaticReentryClaimId }
            : {}),
        ...(typeof raw.automaticReentryEpoch === "number" && Number.isSafeInteger(raw.automaticReentryEpoch) && raw.automaticReentryEpoch >= 0
            ? { automaticReentryEpoch: raw.automaticReentryEpoch }
            : {}),
        ...(typeof raw.automaticReentrySuppressedAt === "string" && raw.automaticReentrySuppressedAt.length > 0
            ? { automaticReentrySuppressedAt: raw.automaticReentrySuppressedAt }
            : {}),
        ...(typeof raw.automaticReentrySuppressionReason === "string" && raw.automaticReentrySuppressionReason.length > 0
            ? { automaticReentrySuppressionReason: raw.automaticReentrySuppressionReason }
            : {}),
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        environments: [...byInstance.values()],
        ...(externalBindings.length === 0 ? {} : { externalBindings }),
        expiresAt: record.expiresAt,
        instance: record.instance,
        lastAccessedAt: record.lastAccessedAt,
        principal: record.principal,
        status: status as "active" | "expired" | "disabled",
        temporaryDirectory: record.temporaryDirectory,
        workspace: record.workspace,
    };
}

function automaticReentryState(record: McpContextStoredRecord, now = Date.now()): McpContextAutomaticReentryState {
    const pending = automaticReentryClaimFresh(record, now);
    return {
        ...(pending && record.automaticReentryClaimId !== undefined ? { claimId: record.automaticReentryClaimId } : {}),
        epoch: record.automaticReentryEpoch ?? 0,
        pending,
        ...(record.automaticReentrySuppressedAt === undefined ? {} : { suppressedAt: record.automaticReentrySuppressedAt }),
        ...(record.automaticReentrySuppressionReason === undefined ? {} : { reason: record.automaticReentrySuppressionReason }),
    };
}

function automaticReentryClaimFresh(record: McpContextStoredRecord, now: number): boolean {
    if (record.automaticReentryClaimId === undefined || record.automaticReentryClaimedAt === undefined) return false;
    const claimedAt = Date.parse(record.automaticReentryClaimedAt);
    return Number.isFinite(claimedAt) && now - claimedAt < AUTOMATIC_REENTRY_CLAIM_TTL_MS;
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
