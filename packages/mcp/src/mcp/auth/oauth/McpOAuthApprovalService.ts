import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { type OAuthApprovalDecision, type OAuthApprovalKind, type OAuthApprovalRequest } from "@portable-devshell/shared";

const approvalTimeoutMs = 300_000;

export interface OAuthApprovalInput {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    requestedResources?: string[];
    requestedScopes?: string[];
}

export class McpOAuthApprovalService {
    readonly #filePath: string;
    readonly #now: () => number;
    readonly #timeoutMs: number;
    readonly #requests = new Map<string, OAuthApprovalRequest>();
    readonly #authorizationByInteraction = new Map<string, string>();

    constructor(storageDir: string, options?: { now?: () => number; timeoutMs?: number }) {
        this.#filePath = join(storageDir, "approvals.jsonl");
        this.#now = options?.now ?? Date.now;
        this.#timeoutMs = options?.timeoutMs ?? approvalTimeoutMs;
    }

    async warmup(): Promise<void> {
        for (const request of await this.#readAll()) {
            this.#requests.set(request.approvalId, request);
        }

        await this.#expirePending();
    }

    async registerClient(input: OAuthApprovalInput): Promise<OAuthApprovalRequest> {
        const existing = [...this.#requests.values()].find((request) => request.kind === "registration" && request.clientId === input.clientId);

        if (existing !== undefined) {
            return existing;
        }

        return await this.#create("registration", input);
    }

    async requestAuthorization(interactionId: string, input: OAuthApprovalInput): Promise<OAuthApprovalRequest> {
        await this.#expirePending();
        const registration = await this.registerClient(input);

        if (registration.status !== "approved") {
            return registration;
        }

        const existingId = this.#authorizationByInteraction.get(interactionId);
        if (existingId !== undefined) {
            const existing = this.#requests.get(existingId);
            if (existing !== undefined) {
                return existing;
            }
        }

        const request = await this.#create("authorization", input);
        this.#authorizationByInteraction.set(interactionId, request.approvalId);
        return request;
    }

    async list(): Promise<OAuthApprovalRequest[]> {
        await this.#expirePending();
        return [...this.#requests.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    async get(approvalId: string): Promise<OAuthApprovalRequest | undefined> {
        await this.#expirePending();
        return this.#requests.get(approvalId);
    }

    async getAuthorization(interactionId: string): Promise<OAuthApprovalRequest | undefined> {
        const approvalId = this.#authorizationByInteraction.get(interactionId);
        return approvalId === undefined ? undefined : await this.get(approvalId);
    }

    async decide(approvalId: string, decision: OAuthApprovalDecision, decidedBy: "cli" | "tui"): Promise<OAuthApprovalRequest> {
        await this.#expirePending();
        const request = this.#requests.get(approvalId);

        if (request === undefined) {
            throw new Error(`OAuth approval ${approvalId} was not found.`);
        }

        if (request.status !== "pending") {
            throw new Error(`OAuth approval ${approvalId} is already ${request.status}.`);
        }

        const next: OAuthApprovalRequest = {
            ...request,
            decidedAt: new Date().toISOString(),
            decidedBy,
            status: decision === "approve" ? "approved" : "denied"
        };
        this.#requests.set(next.approvalId, next);
        await this.#append(next);
        return next;
    }

    async #create(kind: OAuthApprovalKind, input: OAuthApprovalInput): Promise<OAuthApprovalRequest> {
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
        await this.#append(request);
        return request;
    }

    async #expirePending(): Promise<void> {
        const now = this.#now();
        const expired = [...this.#requests.values()].filter((request) => request.status === "pending" && Date.parse(request.expiresAt) <= now);

        for (const request of expired) {
            const next: OAuthApprovalRequest = { ...request, status: "expired" };
            this.#requests.set(next.approvalId, next);
            await this.#append(next);
        }
    }

    async #append(request: OAuthApprovalRequest): Promise<void> {
        await mkdir(dirname(this.#filePath), { recursive: true });
        await appendFile(this.#filePath, `${JSON.stringify(request)}\n`, "utf8");
    }

    async #readAll(): Promise<OAuthApprovalRequest[]> {
        let contents = "";

        try {
            contents = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
