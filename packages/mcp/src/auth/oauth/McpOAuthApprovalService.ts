import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type OAuthApprovalDecision, type OAuthApprovalKind, type OAuthApprovalRequest } from "@portable-devshell/shared";

const approvalTimeoutMs = 300_000;
const defaultMaxEntries = 2048;
const defaultMaxPendingRegistrations = 128;

export interface OAuthApprovalInput {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    requestedResources?: string[];
    requestedScopes?: string[];
}

export interface McpOAuthApprovalServiceOptions {
    maxEntries?: number;
    maxPendingRegistrations?: number;
    now?: () => number;
    timeoutMs?: number;
}

export class McpOAuthApprovalService {
    readonly #filePath: string;
    readonly #maxEntries: number;
    readonly #maxPendingRegistrations: number;
    readonly #mutex = new AsyncMutex();
    readonly #now: () => number;
    readonly #timeoutMs: number;
    readonly #requests = new Map<string, OAuthApprovalRequest>();
    readonly #authorizationByInteraction = new Map<string, string>();

    constructor(storageDir: string, options: McpOAuthApprovalServiceOptions = {}) {
        this.#filePath = join(storageDir, "approvals.jsonl");
        this.#maxEntries = positiveInteger(options.maxEntries, defaultMaxEntries, "maxEntries");
        this.#maxPendingRegistrations = positiveInteger(
            options.maxPendingRegistrations,
            defaultMaxPendingRegistrations,
            "maxPendingRegistrations"
        );
        this.#now = options.now ?? Date.now;
        this.#timeoutMs = positiveInteger(options.timeoutMs, approvalTimeoutMs, "timeoutMs");
    }

    async warmup(): Promise<void> {
        await this.#mutex.runExclusive(async () => {
            this.#requests.clear();
            for (const request of await this.#readAll()) {
                this.#requests.set(request.approvalId, request);
            }
            const changed = this.#expirePendingLocked() || this.#compactLocked();
            if (changed) {
                await this.#persistLocked();
            } else {
                await this.#ensureStoragePermissions();
            }
        });
    }

    async registerClient(input: OAuthApprovalInput): Promise<OAuthApprovalRequest> {
        return await this.#mutex.runExclusive(async () => {
            const changed = this.#expirePendingLocked();
            const existing = this.#findRegistration(input.clientId);
            if (existing !== undefined) {
                if (changed) await this.#persistLocked();
                return existing;
            }
            const pendingRegistrations = [...this.#requests.values()].filter(
                (request) => request.kind === "registration" && request.status === "pending"
            ).length;
            if (pendingRegistrations >= this.#maxPendingRegistrations) {
                if (changed) await this.#persistLocked();
                throw new Error(`The pending OAuth registration limit of ${this.#maxPendingRegistrations} was reached.`);
            }
            const request = this.#createLocked("registration", input);
            await this.#persistLocked();
            return request;
        });
    }

    async requestAuthorization(interactionId: string, input: OAuthApprovalInput): Promise<OAuthApprovalRequest> {
        return await this.#mutex.runExclusive(async () => {
            const expired = this.#expirePendingLocked();
            let registration = this.#findRegistration(input.clientId);
            if (registration === undefined) {
                const pendingRegistrations = [...this.#requests.values()].filter(
                    (request) => request.kind === "registration" && request.status === "pending"
                ).length;
                if (pendingRegistrations >= this.#maxPendingRegistrations) {
                    await this.#persistLocked();
                    throw new Error(`The pending OAuth registration limit of ${this.#maxPendingRegistrations} was reached.`);
                }
                registration = this.#createLocked("registration", input);
                await this.#persistLocked();
            }

            if (registration.status !== "approved") {
                if (expired) {
                    await this.#persistLocked();
                }
                return registration;
            }

            const existingId = this.#authorizationByInteraction.get(interactionId);
            if (existingId !== undefined) {
                const existing = this.#requests.get(existingId);
                if (existing !== undefined) {
                    if (expired) {
                        await this.#persistLocked();
                    }
                    return existing;
                }
            }

            const request = this.#createLocked("authorization", input);
            this.#authorizationByInteraction.set(interactionId, request.approvalId);
            await this.#persistLocked();
            return request;
        });
    }

    async list(): Promise<OAuthApprovalRequest[]> {
        return await this.#mutex.runExclusive(async () => {
            if (this.#expirePendingLocked()) {
                await this.#persistLocked();
            }
            return [...this.#requests.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        });
    }

    async get(approvalId: string): Promise<OAuthApprovalRequest | undefined> {
        return await this.#mutex.runExclusive(async () => {
            if (this.#expirePendingLocked()) {
                await this.#persistLocked();
            }
            return this.#requests.get(approvalId);
        });
    }

    async getAuthorization(interactionId: string): Promise<OAuthApprovalRequest | undefined> {
        return await this.#mutex.runExclusive(async () => {
            if (this.#expirePendingLocked()) {
                await this.#persistLocked();
            }
            const approvalId = this.#authorizationByInteraction.get(interactionId);
            return approvalId === undefined ? undefined : this.#requests.get(approvalId);
        });
    }

    async decide(approvalId: string, decision: OAuthApprovalDecision, decidedBy: "cli" | "tui"): Promise<OAuthApprovalRequest> {
        return await this.#mutex.runExclusive(async () => {
            this.#expirePendingLocked();
            const request = this.#requests.get(approvalId);
            if (request === undefined) {
                throw new Error(`OAuth approval ${approvalId} was not found.`);
            }
            if (request.status !== "pending") {
                throw new Error(`OAuth approval ${approvalId} is already ${request.status}.`);
            }

            const next: OAuthApprovalRequest = {
                ...request,
                decidedAt: new Date(this.#now()).toISOString(),
                decidedBy,
                status: decision === "approve" ? "approved" : "denied"
            };
            this.#requests.set(next.approvalId, next);
            await this.#persistLocked();
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
        while (this.#requests.size > this.#maxEntries) {
            const removable = this.#oldestTerminalRequest();
            if (removable === undefined) {
                break;
            }
            this.#requests.delete(removable.approvalId);
            changed = true;
        }
        return changed;
    }

    #makeRoomLocked(): void {
        while (this.#requests.size >= this.#maxEntries) {
            const removable = this.#oldestTerminalRequest();
            if (removable === undefined) {
                throw new Error(`The OAuth approval storage limit of ${this.#maxEntries} entries was reached.`);
            }
            this.#requests.delete(removable.approvalId);
        }
    }

    #oldestTerminalRequest(): OAuthApprovalRequest | undefined {
        return [...this.#requests.values()]
            .filter((request) => request.status !== "pending")
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
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
