import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type OAuthApprovalDecision, type OAuthApprovalKind, type OAuthApprovalRequest } from "@portable-devshell/shared";

const approvalTimeoutMs = 300_000;
const defaultMaxEntries = 2048;
const defaultMaxInputBytes = 8 * 1024;
const defaultMaxPendingRegistrations = 128;
const defaultMaxTerminalEntries = 256;

export class OAuthApprovalCapacityError extends Error {}

export interface OAuthApprovalInput {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    requestedResources?: string[];
    requestedScopes?: string[];
}

export interface McpOAuthApprovalServiceOptions {
    maxEntries?: number;
    maxInputBytes?: number;
    maxPendingRegistrations?: number;
    maxTerminalEntries?: number;
    now?: () => number;
    timeoutMs?: number;
}

interface OAuthApprovalMemorySnapshot {
    authorizationByInteraction: Map<string, string>;
    authorizationByTransaction: Map<string, { approvalId: string; requestKey: string }>;
    requests: Map<string, OAuthApprovalRequest>;
}

export class McpOAuthApprovalService {
    readonly #filePath: string;
    readonly #maxEntries: number;
    readonly #maxInputBytes: number;
    readonly #maxPendingRegistrations: number;
    readonly #maxTerminalEntries: number;
    readonly #mutex = new AsyncMutex();
    readonly #now: () => number;
    readonly #timeoutMs: number;
    readonly #requests = new Map<string, OAuthApprovalRequest>();
    readonly #authorizationByInteraction = new Map<string, string>();
    readonly #authorizationByTransaction = new Map<string, { approvalId: string; requestKey: string }>();

    constructor(storageDir: string, options: McpOAuthApprovalServiceOptions = {}) {
        this.#filePath = join(storageDir, "approvals.jsonl");
        this.#maxEntries = positiveInteger(options.maxEntries, defaultMaxEntries, "maxEntries");
        this.#maxInputBytes = positiveInteger(options.maxInputBytes, defaultMaxInputBytes, "maxInputBytes");
        this.#maxPendingRegistrations = positiveInteger(
            options.maxPendingRegistrations,
            defaultMaxPendingRegistrations,
            "maxPendingRegistrations"
        );
        this.#maxTerminalEntries = positiveInteger(
            options.maxTerminalEntries,
            defaultMaxTerminalEntries,
            "maxTerminalEntries"
        );
        this.#now = options.now ?? Date.now;
        this.#timeoutMs = positiveInteger(options.timeoutMs, approvalTimeoutMs, "timeoutMs");
    }

    async warmup(): Promise<void> {
        await this.#mutex.runExclusive(async () => {
            this.#requests.clear();
            this.#authorizationByInteraction.clear();
            this.#authorizationByTransaction.clear();
            for (const request of await this.#readAll()) {
                this.#requests.set(request.approvalId, request);
            }
            const expired = this.#expirePendingLocked();
            const compacted = this.#compactLocked();
            const changed = expired || compacted;
            if (changed) {
                await this.#persistLocked();
            } else {
                await this.#ensureStoragePermissions();
            }
        });
    }

    async registerClient(input: OAuthApprovalInput): Promise<OAuthApprovalRequest> {
        this.#validateInput(input);
        return await this.#mutex.runExclusive(async () => {
            const previous = this.#snapshotLocked();
            const expired = this.#expirePendingLocked();
            const compacted = this.#compactLocked();
            const changed = expired || compacted;
            const existing = this.#findRegistration(input.clientId);
            if (existing !== undefined) {
                if (changed) await this.#persistLockedWithRollback(previous);
                return existing;
            }
            const pendingRegistrations = [...this.#requests.values()].filter(
                (request) => request.kind === "registration" && request.status === "pending"
            ).length;
            if (pendingRegistrations >= this.#maxPendingRegistrations) {
                if (changed) await this.#persistLockedWithRollback(previous);
                throw new OAuthApprovalCapacityError(`The pending OAuth registration limit of ${this.#maxPendingRegistrations} was reached.`);
            }
            const request = this.#createLocked("registration", input);
            await this.#persistLockedWithRollback(previous);
            return request;
        });
    }

    async requestAuthorization(
        interactionId: string,
        transactionId: string,
        input: OAuthApprovalInput
    ): Promise<OAuthApprovalRequest> {
        this.#validateInput(input);
        return await this.#mutex.runExclusive(async () => {
            const previous = this.#snapshotLocked();
            const expiredPending = this.#expirePendingLocked();
            const compacted = this.#compactLocked();
            const changed = expiredPending || compacted;
            let registration = this.#findRegistration(input.clientId);
            if (registration === undefined) {
                const pendingRegistrations = [...this.#requests.values()].filter(
                    (request) => request.kind === "registration" && request.status === "pending"
                ).length;
                if (pendingRegistrations >= this.#maxPendingRegistrations) {
                    await this.#persistLockedWithRollback(previous);
                    throw new OAuthApprovalCapacityError(`The pending OAuth registration limit of ${this.#maxPendingRegistrations} was reached.`);
                }
                registration = this.#createLocked("registration", input);
                await this.#persistLockedWithRollback(previous);
            }

            if (registration.status !== "approved") {
                if (changed) {
                    await this.#persistLockedWithRollback(previous);
                }
                return registration;
            }

            const interactionApproval = this.#authorizationByInteraction.get(interactionId);
            if (interactionApproval !== undefined) {
                const existing = this.#requests.get(interactionApproval);
                if (existing !== undefined) {
                    if (changed) {
                        await this.#persistLockedWithRollback(previous);
                    }
                    return existing;
                }
            }

            const requestKey = authorizationRequestKey(input);
            const transactionApproval = this.#authorizationByTransaction.get(transactionId);
            if (transactionApproval !== undefined && transactionApproval.requestKey === requestKey) {
                const existing = this.#requests.get(transactionApproval.approvalId);
                if (existing !== undefined) {
                    this.#authorizationByInteraction.set(interactionId, existing.approvalId);
                    if (changed) {
                        await this.#persistLockedWithRollback(previous);
                    }
                    return existing;
                }
            }

            const request = this.#createLocked("authorization", input);
            this.#authorizationByInteraction.set(interactionId, request.approvalId);
            this.#authorizationByTransaction.set(transactionId, { approvalId: request.approvalId, requestKey });
            await this.#persistLockedWithRollback(previous);
            return request;
        });
    }

    async list(): Promise<OAuthApprovalRequest[]> {
        return await this.#mutex.runExclusive(async () => {
            return [...this.#requests.values()]
                .map((request) => this.#readRequestLocked(request))
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        });
    }

    async get(approvalId: string): Promise<OAuthApprovalRequest | undefined> {
        return await this.#mutex.runExclusive(async () => {
            const request = this.#requests.get(approvalId);
            return request === undefined ? undefined : this.#readRequestLocked(request);
        });
    }

    async getAuthorization(interactionId: string): Promise<OAuthApprovalRequest | undefined> {
        return await this.#mutex.runExclusive(async () => {
            const approvalId = this.#authorizationByInteraction.get(interactionId);
            const request = approvalId === undefined ? undefined : this.#requests.get(approvalId);
            return request === undefined ? undefined : this.#readRequestLocked(request);
        });
    }

    async completeAuthorization(interactionId: string): Promise<void> {
        await this.#mutex.runExclusive(async () => {
            const approvalId = this.#authorizationByInteraction.get(interactionId);
            if (approvalId === undefined) return;
            this.#removeApprovalBindingsLocked(approvalId);
        });
    }

    async decide(
        approvalId: string,
        decision: OAuthApprovalDecision,
        decidedBy: "cli" | "tui" | "web"
    ): Promise<OAuthApprovalRequest> {
        return await this.#mutex.runExclusive(async () => {
            const previous = this.#snapshotLocked();
            const expired = this.#expirePendingLocked();
            const compacted = this.#compactLocked();
            const changed = expired || compacted;
            const request = this.#requests.get(approvalId);
            if (request === undefined) {
                if (changed) await this.#persistLockedWithRollback(previous);
                throw new Error(`OAuth approval ${approvalId} was not found.`);
            }
            if (request.status !== "pending") {
                if (changed) await this.#persistLockedWithRollback(previous);
                throw new Error(`OAuth approval ${approvalId} is already ${request.status}.`);
            }

            const next: OAuthApprovalRequest = {
                ...request,
                decidedAt: new Date(this.#now()).toISOString(),
                decidedBy,
                status: decision === "approve" ? "approved" : "denied"
            };
            this.#requests.set(next.approvalId, next);
            this.#compactLocked();
            await this.#persistLockedWithRollback(previous);
            return next;
        });
    }

    #createLocked(kind: OAuthApprovalKind, input: OAuthApprovalInput): OAuthApprovalRequest {
        this.#makeRoomLocked();
        const createdAt = new Date(this.#now()).toISOString();
        const request: OAuthApprovalRequest = {
            approvalId: randomUUID(),
            clientId: input.clientId,
            clientName: input.clientName,
            createdAt,
            expiresAt: new Date(this.#now() + this.#timeoutMs).toISOString(),
            kind,
            redirectUris: [...input.redirectUris],
            requestedResources: [...(input.requestedResources ?? [])],
            requestedScopes: [...(input.requestedScopes ?? [])],
            status: "pending"
        };
        this.#requests.set(request.approvalId, request);
        return request;
    }

    #findRegistration(clientId: string): OAuthApprovalRequest | undefined {
        return [...this.#requests.values()].find(
            (request) => request.kind === "registration" && request.clientId === clientId && request.status !== "expired"
        );
    }

    #readRequestLocked(request: OAuthApprovalRequest): OAuthApprovalRequest {
        return request.status === "pending" && Date.parse(request.expiresAt) <= this.#now()
            ? { ...request, status: "expired" }
            : request;
    }

    #expirePendingLocked(): boolean {
        const now = this.#now();
        let changed = false;
        for (const request of this.#requests.values()) {
            if (request.status !== "pending" || Date.parse(request.expiresAt) > now) {
                continue;
            }
            this.#requests.set(request.approvalId, { ...request, status: "expired" });
            changed = true;
        }
        return changed;
    }

    #compactLocked(): boolean {
        let changed = false;
        const removableTerminal = this.#removableTerminalRequests();
        while (removableTerminal.length > this.#maxTerminalEntries) {
            const removable = removableTerminal.shift()!;
            this.#requests.delete(removable.approvalId);
            this.#removeApprovalBindingsLocked(removable.approvalId);
            changed = true;
        }
        while (this.#requests.size > this.#maxEntries) {
            const removable = this.#oldestTerminalRequest();
            if (removable === undefined) {
                break;
            }
            this.#requests.delete(removable.approvalId);
            this.#removeApprovalBindingsLocked(removable.approvalId);
            changed = true;
        }
        return changed;
    }

    #makeRoomLocked(): void {
        this.#compactLocked();
        while (this.#requests.size >= this.#maxEntries) {
            const removable = this.#oldestTerminalRequest();
            if (removable === undefined) {
                throw new OAuthApprovalCapacityError(`The OAuth approval storage limit of ${this.#maxEntries} entries was reached.`);
            }
            this.#requests.delete(removable.approvalId);
            this.#removeApprovalBindingsLocked(removable.approvalId);
        }
    }

    #removeApprovalBindingsLocked(approvalId: string): void {
        for (const [interactionId, candidate] of this.#authorizationByInteraction) {
            if (candidate === approvalId) this.#authorizationByInteraction.delete(interactionId);
        }
        for (const [transactionId, candidate] of this.#authorizationByTransaction) {
            if (candidate.approvalId === approvalId) this.#authorizationByTransaction.delete(transactionId);
        }
    }

    #oldestTerminalRequest(): OAuthApprovalRequest | undefined {
        return [...this.#requests.values()]
            .filter((request) => request.status !== "pending")
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    }

    #removableTerminalRequests(): OAuthApprovalRequest[] {
        return [...this.#requests.values()]
            .filter((request) => request.status !== "pending" && !isApprovedRegistration(request))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    #validateInput(input: OAuthApprovalInput): void {
        const bytes = Buffer.byteLength(JSON.stringify({
            clientId: input.clientId,
            clientName: input.clientName,
            redirectUris: input.redirectUris,
            requestedResources: input.requestedResources ?? [],
            requestedScopes: input.requestedScopes ?? []
        }), "utf8");
        if (bytes > this.#maxInputBytes) {
            throw new OAuthApprovalCapacityError(
                `OAuth approval input exceeds the ${this.#maxInputBytes} byte storage limit.`
            );
        }
    }

    #snapshotLocked(): OAuthApprovalMemorySnapshot {
        return {
            authorizationByInteraction: new Map(this.#authorizationByInteraction),
            authorizationByTransaction: new Map(
                [...this.#authorizationByTransaction].map(([key, value]) => [key, { ...value }])
            ),
            requests: new Map(
                [...this.#requests].map(([key, value]) => [key, { ...value }])
            )
        };
    }

    #restoreLocked(snapshot: OAuthApprovalMemorySnapshot): void {
        this.#requests.clear();
        for (const [key, value] of snapshot.requests) this.#requests.set(key, { ...value });
        this.#authorizationByInteraction.clear();
        for (const [key, value] of snapshot.authorizationByInteraction) {
            this.#authorizationByInteraction.set(key, value);
        }
        this.#authorizationByTransaction.clear();
        for (const [key, value] of snapshot.authorizationByTransaction) {
            this.#authorizationByTransaction.set(key, { ...value });
        }
    }

    async #persistLockedWithRollback(previous: OAuthApprovalMemorySnapshot): Promise<void> {
        try {
            await this.#persistLocked();
        } catch (error) {
            this.#restoreLocked(previous);
            throw error;
        }
    }

    async #persistLocked(): Promise<void> {
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        if (process.platform !== "win32") {
            await chmod(directory, 0o700);
        }
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const contents = [...this.#requests.values()]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .map((request) => JSON.stringify(request))
            .join("\n");
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(contents.length === 0 ? "" : `${contents}\n`, "utf8");
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
                await chmod(this.#filePath, 0o600);
                const directoryHandle = await open(directory, "r");
                try {
                    await directoryHandle.sync();
                } finally {
                    await directoryHandle.close();
                }
            }
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async #ensureStoragePermissions(): Promise<void> {
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        if (process.platform === "win32") return;
        await chmod(directory, 0o700);
        await chmod(this.#filePath, 0o600).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
        });
    }

    async #readAll(): Promise<OAuthApprovalRequest[]> {
        let contents = "";
        try {
            contents = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if (isMissing(error)) {
                return [];
            }
            throw error;
        }
        return contents
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as OAuthApprovalRequest);
    }
}

function authorizationRequestKey(input: OAuthApprovalInput): string {
    return JSON.stringify({
        clientId: input.clientId,
        clientName: input.clientName,
        redirectUris: normalizedStringSet(input.redirectUris),
        requestedResources: normalizedStringSet(input.requestedResources ?? []),
        requestedScopes: normalizedStringSet(input.requestedScopes ?? [])
    });
}

function isApprovedRegistration(request: OAuthApprovalRequest): boolean {
    return request.kind === "registration" && request.status === "approved";
}

function normalizedStringSet(values: readonly string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

class AsyncMutex {
    #tail: Promise<void> = Promise.resolve();

    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return resolved;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
