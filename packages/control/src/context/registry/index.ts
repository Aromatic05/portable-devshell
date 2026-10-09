import { ContextChangeHub } from "./Change.js";
import { ContextCleanupLedger } from "./Ledger.js";
import {
    invalidContext,
    invalidRemoteHandle,
    maskedInstance,
    invalidExternalBinding,
    expiredContext,
    disabledContext,
    isCtxId,
    cloneRecord,
    cloneRecordForRead,
    cloneStoredRecord,
    contextEnvironment,
    cloneContextMap,
    restoreContextMap,
    isDocument,
    parseRecord,
    appendEnvironmentCleanup,
    isExternalBinding,
    sameExternalBinding,
    bindExternalRecord,
    isMissing,
} from "./Record.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
    type ContextBinding,
    type ContextEnvironment,
    type ContextEnvironmentBinding,
    type ContextExternalBinding,
    type ContextInstanceReference,
    type ContextMaskedInstance,
    type ContextQuery,
    type ContextRecord,
    type ContextSnapshot,
    type ContextValidationBinding,
} from "@portable-devshell/shared";
import type { ContextRegistryPort } from "../Api.js";

import { upgradeContextDocument } from "./Record.js";

import {
    defaultContextTerminalHistory,
    defaultContextTtlMs,
    parseContextEnvironments,
    type ContextDocument,
    type ContextStoredRecord,
    type ContextRegistryOptions,
} from "../Model.js";

export class ContextRegistry implements ContextRegistryPort {
    readonly changes = new ContextChangeHub();
    readonly #publicRecords = new Map<string, string>();
    readonly #contexts = new Map<string, ContextStoredRecord>();
    readonly #ledger: ContextCleanupLedger;
    readonly #filePath?: string;
    readonly #idFactory: () => string;
    readonly #maxTerminalContexts: number;
    readonly #now: () => number;
    readonly #persistedExpiresAt = new Map<string, number>();
    readonly #ttlMs: number;
    #initialized = false;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: ContextRegistryOptions = {}) {
        this.#filePath = options.filePath;
        const state = {
            records: this.#contexts,
            assertInitialized: () => this.#assertInitialized(),
            run: <Result>(operation: () => Promise<Result>) =>
                this.#run(operation),
            mutate: (operation: () => void) =>
                this.#mutateAndPersist(operation),
        };
        this.#ledger = new ContextCleanupLedger(state);
        this.#initialized = this.#filePath === undefined;
        this.#idFactory = options.idFactory ?? (() => `ctx-${randomUUID()}`);
        this.#maxTerminalContexts =
            options.maxTerminalContexts ?? defaultContextTerminalHistory;
        this.#now = options.now ?? Date.now;
        this.#ttlMs = options.ttlMs ?? defaultContextTtlMs;
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

    async create(binding: ContextBinding): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const environments = parseContextEnvironments(
                binding.environments === undefined ? [] : binding.environments,
            );
            if (environments === undefined) {
                throw new Error(
                    "Invalid Context environments: each instance must have at most one valid environment.",
                );
            }
            const now = this.#now();
            let ctxId = this.#idFactory();
            while (this.#contexts.has(ctxId)) {
                ctxId = `ctx-${randomUUID()}`;
            }
            const at = new Date(now).toISOString();
            const record: ContextStoredRecord = {
                principal: binding.principal,
                createdAt: at,
                ctxId,
                environments,
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

    async lookupExternal(
        external: ContextExternalBinding,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            if (!isExternalBinding(external)) {
                throw invalidExternalBinding();
            }
            const matches = this.#externalMatches(external, binding.principal);
            if (matches.length === 0) return undefined;
            if (matches.length !== 1) throw invalidExternalBinding();
            return cloneRecordForRead(matches[0]!, this.#now());
        });
    }

    async lookup(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            return cloneRecordForRead(
                this.#record(ctxId, binding.principal),
                this.#now(),
            );
        });
    }

    async validateAndTouch(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#record(ctxId);
            const now = await this.#requireActive(record);
            if (record.principal !== binding.principal) {
                throw invalidContext(ctxId);
            }
            await this.#touchRecord(record, now);
            return cloneRecord(record);
        });
    }

    async validate(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord> {
        const record = await this.lookup(ctxId, binding);
        if (record.status === "disabled") throw disabledContext(ctxId);
        if (record.status === "expired")
            throw expiredContext(ctxId, record.expiresAt);
        return record;
    }

    async validateForInstance(
        ctxId: string,
        instance: string,
    ): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#record(ctxId);
            await this.#requireActive(record);
            if ((record.maskedInstances ?? []).includes(instance)) {
                throw maskedInstance(ctxId, instance);
            }
            if (contextEnvironment(record, instance) === undefined) {
                throw invalidContext(ctxId);
            }
            return cloneRecord(record);
        });
    }

    async resolveEnvironment(
        ctxId: string,
        instance: string,
    ): Promise<ContextEnvironment | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#activeRecord(ctxId);
            const environment = contextEnvironment(record, instance);
            return environment === undefined ? undefined : { ...environment };
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

    async detachInstance(instance: string): Promise<ContextRecord[]> {
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
                    const environment = record.environments.find(
                        (candidate) => candidate.instance === instance,
                    );
                    if (environment !== undefined) {
                        appendEnvironmentCleanup(record, {
                            instance,
                            kind: "instance_reference",
                        });
                        if (environment.workspace !== undefined) {
                            appendEnvironmentCleanup(record, {
                                instance,
                                kind: "alerts",
                                workspace: environment.workspace,
                            });
                        }
                    }
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
                }
            });
            return affected.map(cloneRecord);
        });
    }

    async attachEnvironment(
        ctxId: string,
        binding: ContextEnvironmentBinding,
        external?: {
            bindings: readonly ContextExternalBinding[];
            principal: string;
        },
    ): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#record(ctxId);
            await this.#requireActive(record);
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
                const next: ContextEnvironment =
                    binding.workspace === undefined
                        ? { ...(current ?? {}), instance: binding.instance }
                        : {
                              instance: binding.instance,
                              ...(binding.temporaryDirectory === undefined
                                  ? {}
                                  : {
                                        temporaryDirectory:
                                            binding.temporaryDirectory,
                                    }),
                              workspace: binding.workspace,
                          };
                if (index < 0) {
                    record.environments.push(next);
                } else {
                    record.environments[index] = next;
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
    ): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#contexts.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
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
    ): Promise<ContextInstanceReference | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#activeRecord(ctxId);
            if ((record.maskedInstances ?? []).includes(instance))
                return undefined;
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
    ): Promise<ContextMaskedInstance> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#activeRecord(ctxId);
            const reference = record.remoteInstanceHandles?.find(
                (candidate) => candidate.handle === handle,
            );
            if (reference === undefined) throw invalidRemoteHandle(ctxId);
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

    async snapshot(): Promise<ContextSnapshot> {
        return this.#run(async () => {
            this.#assertInitialized();
            const now = this.#now();
            this.#publishPublicChanges(now);
            return {
                contexts: [...this.#contexts.values()].map((record) =>
                    cloneRecordForRead(record, now),
                ),
                revision: this.changes.revision,
            };
        });
    }

    async list(query: ContextQuery = {}): Promise<ContextRecord[]> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const now = this.#now();
            return [...this.#contexts.values()]
                .map((record) => cloneRecordForRead(record, now))
                .filter(
                    (record) =>
                        (query.instance === undefined &&
                            query.workspace === undefined) ||
                        record.environments.some(
                            (environment) =>
                                (query.instance === undefined ||
                                    environment.instance === query.instance) &&
                                (query.workspace === undefined ||
                                    environment.workspace === query.workspace),
                        ),
                )
                .filter(
                    (record) =>
                        query.status === undefined ||
                        record.status === query.status,
                )
                .sort((left, right) =>
                    left.createdAt.localeCompare(right.createdAt),
                );
        });
    }

    listCleanupPending(
        ...args: Parameters<ContextCleanupLedger["listCleanupPending"]>
    ): ReturnType<ContextCleanupLedger["listCleanupPending"]> {
        return this.#ledger.listCleanupPending(...args);
    }

    listEnvironmentCleanup(
        ...args: Parameters<ContextCleanupLedger["listEnvironmentCleanup"]>
    ): ReturnType<ContextCleanupLedger["listEnvironmentCleanup"]> {
        return this.#ledger.listEnvironmentCleanup(...args);
    }

    recordEnvironmentCleanup(
        ...args: Parameters<ContextCleanupLedger["recordEnvironmentCleanup"]>
    ): ReturnType<ContextCleanupLedger["recordEnvironmentCleanup"]> {
        return this.#ledger.recordEnvironmentCleanup(...args);
    }

    async disable(ctxId: string): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#record(ctxId);
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

    settleCleanup(
        ...args: Parameters<ContextCleanupLedger["settleCleanup"]>
    ): ReturnType<ContextCleanupLedger["settleCleanup"]> {
        return this.#ledger.settleCleanup(...args);
    }

    settleEnvironmentCleanup(
        ...args: Parameters<ContextCleanupLedger["settleEnvironmentCleanup"]>
    ): ReturnType<ContextCleanupLedger["settleEnvironmentCleanup"]> {
        return this.#ledger.settleEnvironmentCleanup(...args);
    }

    async discard(ctxId: string): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#record(ctxId);
            await this.#mutateAndPersist(() => {
                this.#contexts.delete(ctxId);
            });
            return cloneRecord(record);
        });
    }

    async renewForPrincipal(
        ctxId: string,
        binding: ContextValidationBinding,
    ): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            return await this.#renew(this.#record(ctxId, binding.principal));
        });
    }

    async renew(ctxId: string): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            return await this.#renew(this.#record(ctxId));
        });
    }

    async updateWorkerState(
        ctxId: string,
        instance: string,
        binding: Pick<
            ContextEnvironmentBinding,
            "temporaryDirectory" | "workspace"
        >,
    ): Promise<ContextRecord> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const record = this.#record(ctxId);
            await this.#requireActive(record);
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
            });
            return cloneRecord(record);
        });
    }

    #activeRecord(ctxId: string): ContextStoredRecord {
        const record = this.#record(ctxId);
        if (record.status === "disabled") throw disabledContext(ctxId);
        if (
            record.status === "expired" ||
            Date.parse(record.expiresAt) <= this.#now()
        ) {
            throw expiredContext(ctxId, record.expiresAt);
        }
        return record;
    }

    #record(ctxId: string, principal?: string): ContextStoredRecord {
        const record = isCtxId(ctxId) ? this.#contexts.get(ctxId) : undefined;
        if (
            record === undefined ||
            (principal !== undefined && record.principal !== principal)
        )
            throw invalidContext(ctxId);
        return record;
    }

    async #renew(record: ContextStoredRecord): Promise<ContextRecord> {
        if (record.status === "disabled") throw disabledContext(record.ctxId);
        if (record.status === "expired" && record.cleanupPending === true)
            throw expiredContext(record.ctxId, record.expiresAt);
        const now = this.#now();
        await this.#mutateAndPersist(() => {
            record.status = "active";
            record.lastAccessedAt = new Date(now).toISOString();
            record.expiresAt = new Date(now + this.#ttlMs).toISOString();
        });
        return cloneRecord(record);
    }

    async #requireActive(record: ContextStoredRecord): Promise<number> {
        if (record.status === "disabled") throw disabledContext(record.ctxId);
        const now = this.#now();
        if (
            record.status !== "expired" &&
            !(Date.parse(record.expiresAt) <= now)
        )
            return now;
        if (record.status !== "expired")
            await this.#mutateAndPersist(() => {
                record.status = "expired";
            });
        throw expiredContext(record.ctxId, record.expiresAt);
    }

    #externalMatches(
        external: ContextExternalBinding,
        principal: string,
    ): ContextStoredRecord[] {
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
        try {
            mutate();
            this.#expireOverdue(this.#now());
            this.#compactTerminalContexts();
            await this.#persist();
        } catch (error) {
            restoreContextMap(this.#contexts, previous);
            throw error;
        }
    }

    async #touchRecord(
        record: ContextStoredRecord,
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
        const current = JSON.parse(raw) as unknown;
        if (
            typeof current === "object" &&
            current !== null &&
            !Array.isArray(current) &&
            (current as { version?: unknown }).version === 1
        ) {
            await upgradeContextDocument(this.#filePath);
            raw = await readFile(this.#filePath, "utf8");
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
            throw new Error(
                `Invalid MCP context registry record: ${this.#filePath}`,
            );
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
        const document: ContextDocument = {
            contexts: [...this.#contexts.values()].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            ),
            version: 2,
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

    #publishPublicChanges(now?: number): void {
        if (!this.#initialized) return;
        const observedAt = now ?? this.#now();
        const current = new Map(
            [...this.#contexts.values()].map((record) => [
                record.ctxId,
                JSON.stringify(cloneRecordForRead(record, observedAt)),
            ]),
        );
        const changed = [
            ...new Set([...this.#publicRecords.keys(), ...current.keys()]),
        ].filter(
            (ctxId) => this.#publicRecords.get(ctxId) !== current.get(ctxId),
        );
        this.#publicRecords.clear();
        for (const [ctxId, record] of current)
            this.#publicRecords.set(ctxId, record);
        const terminal = changed.filter((ctxId) => {
            const record = this.#contexts.get(ctxId);
            return record === undefined || record.status === "disabled";
        });
        this.changes.publish(changed, terminal);
    }

    async #run<T>(operation: () => Promise<T>): Promise<T> {
        const observe = async () => {
            try {
                return await operation();
            } finally {
                this.#publishPublicChanges();
            }
        };
        const result = this.#operation.then(observe, observe);
        this.#operation = result.then(
            () => undefined,
            () => undefined,
        );
        return await result;
    }
}
