import {
    createHash,
    randomBytes,
    randomUUID,
    timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface McpAppLeaseRecord {
    createdAt: string;
    ctxId: string;
    instance: string;
    tokenHashes: string[];
    updatedAt: string;
}

interface McpAppLeaseDocument {
    leases: McpAppLeaseRecord[];
    version: 2;
}

const MAX_TOKENS_PER_LEASE = 8;

export interface McpAppLeaseStoreOptions {
    filePath?: string;
    now?: () => number;
    tokenFactory?: () => string;
}

export class McpAppLeaseStore {
    readonly #filePath?: string;
    readonly #leases = new Map<string, McpAppLeaseRecord>();
    readonly #now: () => number;
    readonly #plainTokens = new Map<string, string>();
    readonly #tokenFactory: () => string;
    #initialized: boolean;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: McpAppLeaseStoreOptions = {}) {
        this.#filePath = options.filePath;
        this.#initialized = this.#filePath === undefined;
        this.#now = options.now ?? Date.now;
        this.#tokenFactory =
            options.tokenFactory ??
            (() => randomBytes(32).toString("base64url"));
    }

    async initialize(): Promise<void> {
        await this.#run(async () => {
            if (this.#initialized) return;
            await this.#load();
            this.#initialized = true;
        });
    }

    async issue(instance: string, ctxId: string): Promise<string> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const key = leaseKey(instance, ctxId);
            const current = this.#leases.get(key);
            const plain = this.#plainTokens.get(key);
            if (
                current !== undefined &&
                plain !== undefined &&
                tokenMatchesAny(current.tokenHashes, plain)
            ) {
                return plain;
            }

            const token = this.#tokenFactory();
            if (token.length < 16)
                throw new Error(
                    "MCP App token factory returned an invalid token.",
                );
            const now = new Date(this.#now()).toISOString();
            const previous = cloneLeaseMap(this.#leases);
            const tokenHash = hashToken(token);
            const tokenHashes = [
                ...(current?.tokenHashes ?? []).filter(
                    (hash) => hash !== tokenHash,
                ),
                tokenHash,
            ].slice(-MAX_TOKENS_PER_LEASE);
            this.#leases.set(key, {
                createdAt: current?.createdAt ?? now,
                ctxId,
                instance,
                tokenHashes,
                updatedAt: now,
            });
            try {
                await this.#persist();
            } catch (error) {
                restoreLeaseMap(this.#leases, previous);
                throw error;
            }
            this.#plainTokens.set(key, token);
            return token;
        });
    }

    async verify(
        instance: string,
        ctxId: string,
        token: string,
    ): Promise<boolean> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const key = leaseKey(instance, ctxId);
            const lease = this.#leases.get(key);
            if (
                lease === undefined ||
                !tokenMatchesAny(lease.tokenHashes, token)
            )
                return false;
            this.#plainTokens.set(key, token);
            return true;
        });
    }

    async revokeContext(ctxId: string): Promise<void> {
        await this.#remove((lease) => lease.ctxId === ctxId);
    }

    async revokeInstance(instance: string): Promise<void> {
        await this.#remove((lease) => lease.instance === instance);
    }

    async #remove(
        matches: (lease: McpAppLeaseRecord) => boolean,
    ): Promise<void> {
        await this.#run(async () => {
            this.#assertInitialized();
            const keys = [...this.#leases]
                .filter(([, lease]) => matches(lease))
                .map(([key]) => key);
            if (keys.length === 0) return;
            const previous = cloneLeaseMap(this.#leases);
            for (const key of keys) this.#leases.delete(key);
            try {
                await this.#persist();
            } catch (error) {
                restoreLeaseMap(this.#leases, previous);
                throw error;
            }
            for (const key of keys) this.#plainTokens.delete(key);
        });
    }

    async #load(): Promise<void> {
        if (this.#filePath === undefined) return;
        let raw: string;
        try {
            raw = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
        const document = parseDocument(JSON.parse(raw) as unknown);
        if (document === undefined) {
            throw new Error(
                `Invalid MCP App lease store: ${this.#filePath}`,
            );
        }
        this.#leases.clear();
        for (const lease of document.leases) {
            this.#leases.set(leaseKey(lease.instance, lease.ctxId), lease);
        }
    }

    async #persist(): Promise<void> {
        if (this.#filePath === undefined) return;
        await mkdir(dirname(this.#filePath), { recursive: true });
        const document: McpAppLeaseDocument = {
            leases: [...this.#leases.values()].sort(
                (left, right) =>
                    left.instance.localeCompare(right.instance) ||
                    left.ctxId.localeCompare(right.ctxId),
            ),
            version: 2,
        };
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(
                temporary,
                `${JSON.stringify(document, null, 2)}\n`,
                {
                    encoding: "utf8",
                    mode: 0o600,
                },
            );
            await rename(temporary, this.#filePath);
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    #assertInitialized(): void {
        if (!this.#initialized)
            throw new Error("MCP App lease store is not initialized.");
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

function leaseKey(instance: string, ctxId: string): string {
    return `${instance}\0${ctxId}`;
}

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(expectedHash: string, token: string): boolean {
    const actual = Buffer.from(hashToken(token), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
    );
}

function tokenMatchesAny(
    expectedHashes: readonly string[],
    token: string,
): boolean {
    return expectedHashes.some((expectedHash) =>
        tokenMatches(expectedHash, token),
    );
}

function cloneLeaseMap(
    leases: ReadonlyMap<string, McpAppLeaseRecord>,
): Map<string, McpAppLeaseRecord> {
    return new Map(
        [...leases].map(([key, lease]) => [
            key,
            { ...lease, tokenHashes: [...lease.tokenHashes] },
        ]),
    );
}

function restoreLeaseMap(
    leases: Map<string, McpAppLeaseRecord>,
    previous: ReadonlyMap<string, McpAppLeaseRecord>,
): void {
    leases.clear();
    for (const [key, lease] of previous)
        leases.set(key, { ...lease, tokenHashes: [...lease.tokenHashes] });
}

/**
 * @compat mcpapp-lease-v1
 * @removeAt 0.7.10
 */
function parseDocument(value: unknown): McpAppLeaseDocument | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const document = value as { leases?: unknown; version?: unknown };
    if (
        (document.version !== 1 && document.version !== 2) ||
        !Array.isArray(document.leases)
    )
        return undefined;
    const leases = document.leases.map((lease) =>
        document.version === 1 ? parseLegacyLease(lease) : parseLease(lease),
    );
    if (leases.some((lease) => lease === undefined)) return undefined;
    const keys = new Set<string>();
    for (const lease of leases as McpAppLeaseRecord[]) {
        const key = leaseKey(lease.instance, lease.ctxId);
        if (keys.has(key)) return undefined;
        keys.add(key);
    }
    return { leases: leases as McpAppLeaseRecord[], version: 2 };
}

function parseLease(value: unknown): McpAppLeaseRecord | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const lease = value as Partial<McpAppLeaseRecord> & {
        tokenHashes?: unknown;
    };
    if (
        !Array.isArray(lease.tokenHashes) ||
        lease.tokenHashes.length === 0 ||
        lease.tokenHashes.length > MAX_TOKENS_PER_LEASE
    ) {
        return undefined;
    }
    const tokenHashes = lease.tokenHashes.filter(
        (hash): hash is string =>
            typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash),
    );
    if (
        tokenHashes.length !== lease.tokenHashes.length ||
        new Set(tokenHashes).size !== tokenHashes.length
    )
        return undefined;
    if (
        typeof lease.createdAt !== "string" ||
        typeof lease.ctxId !== "string" ||
        lease.ctxId.length === 0 ||
        typeof lease.instance !== "string" ||
        lease.instance.length === 0 ||
        typeof lease.updatedAt !== "string"
    )
        return undefined;
    return {
        createdAt: lease.createdAt,
        ctxId: lease.ctxId,
        instance: lease.instance,
        tokenHashes,
        updatedAt: lease.updatedAt,
    };
}

function parseLegacyLease(value: unknown): McpAppLeaseRecord | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const lease = value as Partial<
        Omit<McpAppLeaseRecord, "tokenHashes">
    > & { tokenHash?: unknown };
    if (
        typeof lease.createdAt !== "string" ||
        typeof lease.ctxId !== "string" ||
        lease.ctxId.length === 0 ||
        typeof lease.instance !== "string" ||
        lease.instance.length === 0 ||
        typeof lease.tokenHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(lease.tokenHash) ||
        typeof lease.updatedAt !== "string"
    )
        return undefined;
    return {
        createdAt: lease.createdAt,
        ctxId: lease.ctxId,
        instance: lease.instance,
        tokenHashes: [lease.tokenHash],
        updatedAt: lease.updatedAt,
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
