import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createError, errorCodes } from "@portable-devshell/shared";

export const defaultMcpContextTtlMs = 24 * 60 * 60 * 1_000;

export interface McpContextBinding {
    instance: string;
    principal: string;
    workspace: string;
}

export interface McpContextRecord extends McpContextBinding {
    createdAt: string;
    ctxId: string;
    expiresAt: string;
    lastAccessedAt: string;
    status: "active" | "expired";
}

interface McpContextDocument {
    contexts: McpContextRecord[];
    version: 1;
}

export interface McpContextRegistryOptions {
    filePath?: string;
    idFactory?: () => string;
    now?: () => number;
    ttlMs?: number;
}

export class McpContextRegistry {
    readonly #contexts = new Map<string, McpContextRecord>();
    readonly #filePath?: string;
    readonly #idFactory: () => string;
    readonly #now: () => number;
    readonly #ttlMs: number;
    #initialized = false;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: McpContextRegistryOptions = {}) {
        this.#filePath = options.filePath;
        this.#initialized = this.#filePath === undefined;
        this.#idFactory = options.idFactory ?? (() => `ctx-${randomUUID()}`);
        this.#now = options.now ?? Date.now;
        this.#ttlMs = options.ttlMs ?? defaultMcpContextTtlMs;
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
            const changed = this.#expireOverdue(this.#now());
            this.#initialized = true;
            if (changed) {
                await this.#persist();
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
            this.#contexts.set(ctxId, record);
            await this.#persist();
            return cloneRecord(record);
        });
    }

    async validateAndTouch(ctxId: string, binding: McpContextBinding): Promise<McpContextRecord> {
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
            if (record.status === "expired" || Date.parse(record.expiresAt) <= now) {
                if (record.status !== "expired") {
                    record.status = "expired";
                    await this.#persist();
                }
                throw expiredContext(ctxId, record.expiresAt);
            }
            if (
                record.principal !== binding.principal ||
                record.instance !== binding.instance ||
                record.workspace !== binding.workspace
            ) {
                throw invalidContext(ctxId);
            }
            record.lastAccessedAt = new Date(now).toISOString();
            record.expiresAt = new Date(now + this.#ttlMs).toISOString();
            await this.#persist();
            return cloneRecord(record);
        });
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
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.#filePath);
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

function isCtxId(value: string): boolean {
    return value.startsWith("ctx-") && value.length > 4;
}

function cloneRecord(record: McpContextRecord): McpContextRecord {
    return { ...record };
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
        (record.status === "active" || record.status === "expired");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
