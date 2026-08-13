import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createError,
    errorCodes,
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

export type McpContextValidationBinding = Omit<McpContextBinding, "workspace">;

interface McpContextDocument {
    contexts: McpContextRecord[];
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
    readonly #contexts = new Map<string, McpContextRecord>();
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
        this.#maxTerminalContexts = options.maxTerminalContexts ?? defaultMcpContextTerminalHistory;
        this.#now = options.now ?? Date.now;
        this.#ttlMs = options.ttlMs ?? defaultMcpContextTtlMs;
        if (!Number.isSafeInteger(this.#maxTerminalContexts) || this.#maxTerminalContexts < 0) {
            throw new Error("MCP context maxTerminalContexts must be a non-negative safe integer.");
        }
        if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
            throw new Error("MCP context ttlMs must be a positive finite number.");
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
            const record: McpContextRecord = {
                ...binding,
                createdAt: at,
                ctxId,
                expiresAt: new Date(now + this.#ttlMs).toISOString(),
                lastAccessedAt: at,
                status: "active"
            };
            await this.#mutateAndPersist(() => {
                this.#contexts.set(ctxId, record);
            });
            return cloneRecord(record);
        });
    }

    async validateAndTouch(ctxId: string, binding: McpContextValidationBinding): Promise<McpContextRecord> {
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
            if (record.status === "expired" || Date.parse(record.expiresAt) <= now) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            if (
                record.principal !== binding.principal ||
                record.instance !== binding.instance
            ) {
                throw invalidContext(ctxId);
            }
            await this.#mutateAndPersist(() => {
                record.lastAccessedAt = new Date(now).toISOString();
                record.expiresAt = new Date(now + this.#ttlMs).toISOString();
            });
            return cloneRecord(record);
        });
    }

    async validateForInstance(ctxId: string, instance: string): Promise<McpContextRecord> {
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
            if (record.status === "expired" || Date.parse(record.expiresAt) <= now) {
                if (record.status !== "expired") {
                    await this.#mutateAndPersist(() => {
                        record.status = "expired";
                    });
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            if (record.instance !== instance) {
                throw invalidContext(ctxId);
            }
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
                .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
        binding: Pick<McpContextBinding, "temporaryDirectory" | "workspace">
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
            if (record.status === "expired") {
                throw expiredContext(ctxId, record.expiresAt);
            }
            await this.#mutateAndPersist(() => {
                record.workspace = binding.workspace;
                record.temporaryDirectory = binding.temporaryDirectory;
            });
            return cloneRecord(record);
        });
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
        for (const record of parsed.contexts) {
            if (isRecord(record)) {
                this.#contexts.set(record.ctxId, { ...record });
            }
        }
    }

    #expireOverdue(now: number): boolean {
        let changed = false;
        for (const record of this.#contexts.values()) {
            if (record.status === "active" && Date.parse(record.expiresAt) <= now) {
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
                return created === 0 ? left.ctxId.localeCompare(right.ctxId) : created;
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
            contexts: [...this.#contexts.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
            version: 1
        };
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
            () => undefined
        );
        return await result;
    }
}

function invalidContext(ctxId: string) {
    return createError({
        code: errorCodes.mcpContextInvalid,
        details: { ctxId },
        message: "ctxId is invalid for the current environment.",
        retryable: false
    });
}

function expiredContext(ctxId: string, expiresAt: string) {
    return createError({
        code: errorCodes.mcpContextExpired,
        details: { ctxId, expiresAt },
        message: "ctxId has expired. Call environ_info to create a new context.",
        retryable: false
    });
}

function disabledContext(ctxId: string) {
    return createError({
        code: errorCodes.mcpContextDisabled,
        details: { ctxId },
        message: "ctxId is disabled. Call environ_info to create a new context.",
        retryable: false
    });
}

function isCtxId(value: string): boolean {
    return value.startsWith("ctx-") && value.length > 4;
}

function cloneRecord(record: McpContextRecord): McpContextRecord {
    return { ...record };
}

function cloneContextMap(
    contexts: ReadonlyMap<string, McpContextRecord>
): Map<string, McpContextRecord> {
    return new Map([...contexts].map(([ctxId, record]) => [ctxId, cloneRecord(record)]));
}

function restoreContextMap(
    contexts: Map<string, McpContextRecord>,
    previous: ReadonlyMap<string, McpContextRecord>
): void {
    contexts.clear();
    for (const [ctxId, record] of previous) {
        contexts.set(ctxId, cloneRecord(record));
    }
}

function isDocument(value: unknown): value is McpContextDocument {
    return typeof value === "object" && value !== null && !Array.isArray(value) &&
        (value as { version?: unknown }).version === 1 && Array.isArray((value as { contexts?: unknown }).contexts);
}

function isRecord(value: unknown): value is McpContextRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Partial<McpContextRecord>;
    return typeof record.ctxId === "string" && isCtxId(record.ctxId) &&
        typeof record.principal === "string" && typeof record.instance === "string" &&
        typeof record.workspace === "string" && typeof record.createdAt === "string" &&
        typeof record.lastAccessedAt === "string" && typeof record.expiresAt === "string" &&
        (record.temporaryDirectory === undefined || typeof record.temporaryDirectory === "string") &&
        (record.status === "active" || record.status === "expired" || record.status === "disabled");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
