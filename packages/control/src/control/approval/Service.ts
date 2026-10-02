import { randomUUID } from "node:crypto";
import {
    createError,
    errorCodes,
    type ApprovalDecision,
    type ApprovalDecisionBy,
    type ApprovalPolicy,
    type ApprovalPolicyDecision,
    type ApprovalRequest,
    type ApprovalTimeout,
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
} from "@portable-devshell/shared";

export class ApprovalError extends Error {
    readonly retryable = false;

    constructor(
        readonly code: string,
        message: string,
        readonly details?: JsonValue,
    ) {
        super(message);
        this.name = "ApprovalError";
    }
}

export interface ApprovalEvaluationInput {
    callId: string;
    context: ToolCallContext;
    inputSummary: string;
    recording?: "caller" | "host";
    required?: boolean;
    toolName: string;
}

export type ApprovalResolution =
    | { decision: ApprovalDecision; status: "approved" }
    | { decision: ApprovalDecision; error: ApprovalError; status: "denied" }
    | { error: ApprovalError; status: "expired" | "cancelled" };

export type ApprovalEvaluation =
    | { decision: "allow" }
    | { decision: "deny"; error: ApprovalError }
    | {
          decision: "ask";
          request: ApprovalRequest;
          awaitDecision: Promise<ApprovalResolution>;
      };

export interface ApprovalStorePort {
    append(request: ApprovalRequest): Promise<void>;
    close?(): void;
    get(approvalId: string): Promise<ApprovalRequest | undefined>;
    list(): Promise<ApprovalRequest[]>;
}

export interface ApprovalEventPort {
    append(
        type:
            | "approval.requested"
            | "approval.approved"
            | "approval.denied"
            | "approval.cancelled"
            | "approval.expired",
        data: Record<string, JsonValue>,
    ): Promise<unknown>;
}

export interface ApprovalServiceOptions {
    instanceName: InstanceName;
    store: ApprovalStorePort;
    policy?: ApprovalPolicy;
    timeout?: ApprovalTimeout;
    now?: () => number;
    createId?: () => string;
}

interface PendingApproval {
    request: ApprovalRequest;
    resolve: (value: ApprovalResolution) => void;
    timeout: NodeJS.Timeout;
}

export class ApprovalService {
    readonly #instance: InstanceName;
    readonly #store: ApprovalStorePort;
    readonly #timeoutMs: number;
    readonly #now: () => number;
    readonly #createId: () => string;
    readonly #pending = new Map<string, PendingApproval>();
    #policy: ApprovalPolicy;
    #operation: Promise<void> = Promise.resolve();
    #ready?: Promise<void>;

    constructor(options: ApprovalServiceOptions) {
        this.#instance = options.instanceName;
        this.#store = options.store;
        this.#policy = options.policy ?? { mode: "disabled" };
        this.#timeoutMs = options.timeout?.ms ?? 300_000;
        this.#now = options.now ?? Date.now;
        this.#createId = options.createId ?? randomUUID;
    }

    setPolicy(policy: ApprovalPolicy | undefined): void {
        this.#policy = policy ?? { mode: "disabled" };
    }

    close(): void {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timeout);
            pending.resolve({
                error: cancelled(this.#instance, pending.request.toolName),
                status: "cancelled",
            });
        }
        this.#pending.clear();
        this.#store.close?.();
    }

    async evaluate(input: ApprovalEvaluationInput): Promise<ApprovalEvaluation> {
        await this.#ensureReady();
        return this.#exclusive(async () => {
            const outcome = policyDecision(
                this.#policy,
                input.context.source,
                input.toolName,
            );
            if (outcome === "deny") {
                return {
                    decision: "deny",
                    error: denied(this.#instance, input.toolName),
                };
            }
            if (outcome === "allow" && input.required !== true) {
                return { decision: "allow" };
            }

            const now = this.#now();
            const request: ApprovalRequest = {
                approvalId: this.#createId(),
                callId: input.callId,
                createdAt: new Date(now).toISOString(),
                expiresAt: new Date(now + this.#timeoutMs).toISOString(),
                inputSummary: input.inputSummary,
                instance: this.#instance,
                reason: `Approval required before running ${input.toolName}.`,
                recording: input.recording ?? "host",
                ...(input.context.requestId === undefined
                    ? {}
                    : { requestId: input.context.requestId }),
                riskLevel: "medium",
                ...(input.context.ctxId === undefined
                    ? {}
                    : { ctxId: input.context.ctxId }),
                source: input.context.source,
                status: "pending",
                toolName: input.toolName,
                ...(input.context.workspace === undefined
                    ? {}
                    : { workspace: input.context.workspace }),
            };
            await this.#store.append(request);

            let resolve!: (value: ApprovalResolution) => void;
            const awaitDecision = new Promise<ApprovalResolution>((done) => {
                resolve = done;
            });
            const pending: PendingApproval = {
                request,
                resolve,
                timeout: undefined as unknown as NodeJS.Timeout,
            };
            this.#pending.set(request.approvalId, pending);
            this.#arm(request.approvalId, pending, this.#timeoutMs);
            return { decision: "ask", request, awaitDecision };
        });
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        await this.#ensureReady();
        return this.#store.list();
    }

    async listPendingApprovals(ctxId?: string): Promise<ApprovalRequest[]> {
        await this.#ensureReady();
        return [...this.#pending.values()]
            .map(({ request }) => request)
            .filter((request) => ctxId === undefined || request.ctxId === ctxId);
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        await this.#ensureReady();
        const request = await this.#store.get(approvalId);
        if (request !== undefined) return request;
        throw notFound(this.#instance, approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: {
            decision: "approve" | "deny";
            decidedBy: ApprovalDecisionBy;
            policyPatch?: JsonValue;
            reason?: string;
            remember?: boolean;
        },
    ): Promise<ApprovalRequest> {
        await this.#ensureReady();
        return this.#exclusive(async () => {
            const pending = this.#pending.get(approvalId);
            const request =
                pending?.request ?? (await this.#store.get(approvalId));
            if (request === undefined) throw notFound(this.#instance, approvalId);
            if (request.status !== "pending") {
                throw createError({
                    code: errorCodes.coreApprovalAlreadyDecided,
                    details: {
                        approvalId,
                        instance: this.#instance,
                        status: request.status,
                    },
                    message: `Approval ${approvalId} was already decided.`,
                    retryable: false,
                });
            }

            const decision: ApprovalDecision = {
                approvalId,
                decidedAt: new Date(this.#now()).toISOString(),
                decidedBy: input.decidedBy,
                decision: input.decision,
                ...(input.policyPatch === undefined
                    ? {}
                    : { policyPatch: input.policyPatch }),
                ...(input.reason === undefined ? {} : { reason: input.reason }),
                ...(input.remember === undefined
                    ? {}
                    : { remember: input.remember }),
            };
            const updated: ApprovalRequest = {
                ...request,
                decision,
                status: input.decision === "approve" ? "approved" : "denied",
            };
            await this.#store.append(updated);
            if (pending !== undefined) {
                clearTimeout(pending.timeout);
                this.#pending.delete(approvalId);
                pending.resolve(
                    input.decision === "approve"
                        ? { decision, status: "approved" }
                        : {
                              decision,
                              error: denied(this.#instance, request.toolName),
                              status: "denied",
                          },
                );
            }
            return updated;
        });
    }

    async cancel(approvalId: string, reason?: string): Promise<ApprovalRequest> {
        await this.#ensureReady();
        return this.#exclusive(() => this.#cancel(approvalId, reason));
    }

    async retire(reason = "instance retired"): Promise<void> {
        await this.#ensureReady();
        await this.#exclusive(async () => {
            for (const pending of [...this.#pending.values()]) {
                await this.#cancel(pending.request.approvalId, reason);
            }
        });
    }

    async #cancel(
        approvalId: string,
        reason?: string,
    ): Promise<ApprovalRequest> {
        const pending = this.#pending.get(approvalId);
        const request = pending?.request ?? (await this.#store.get(approvalId));
        if (request === undefined) throw notFound(this.#instance, approvalId);
        if (request.status !== "pending") return request;

        const updated = { ...request, status: "cancelled" as const };
        await this.#store.append(updated);
        if (pending !== undefined) {
            clearTimeout(pending.timeout);
            this.#pending.delete(approvalId);
            pending.resolve({
                error: cancelled(this.#instance, request.toolName, reason),
                status: "cancelled",
            });
        }
        return updated;
    }

    async #ensureReady(): Promise<void> {
        if (this.#ready === undefined) {
            const ready = (async () => {
                for (const request of await this.#store.list()) {
                    if (request.status !== "pending") continue;
                    const status =
                        Date.parse(request.expiresAt) <= this.#now()
                            ? "expired"
                            : "cancelled";
                    await this.#store.append({ ...request, status });
                }
            })();
            this.#ready = ready;
            void ready.catch(() => {
                if (this.#ready === ready) this.#ready = undefined;
            });
        }
        await this.#ready;
    }

    #arm(id: string, pending: PendingApproval, delay: number): void {
        pending.timeout = setTimeout(() => {
            void this.#expire(id).then(pending.resolve, () => {
                if (this.#pending.get(id) === pending) {
                    this.#arm(id, pending, Math.min(1000, Math.max(1, this.#timeoutMs)));
                }
            });
        }, delay);
    }

    async #expire(id: string): Promise<ApprovalResolution> {
        return this.#exclusive(async () => {
            const pending = this.#pending.get(id);
            if (pending === undefined) {
                return { error: expired(this.#instance, "unknown"), status: "expired" };
            }
            const request = { ...pending.request, status: "expired" as const };
            await this.#store.append(request);
            this.#pending.delete(id);
            return {
                error: expired(this.#instance, request.toolName),
                status: "expired",
            };
        });
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const prior = this.#operation;
        let unlock!: () => void;
        this.#operation = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        await prior;
        try {
            return await operation();
        } finally {
            unlock();
        }
    }
}

function policyDecision(
    policy: ApprovalPolicy,
    source: ToolCallContext["source"],
    tool: string,
): ApprovalPolicyDecision {
    if (!["disabled", "allow", "ask", "deny"].includes(policy.mode)) {
        throw createError({
            code: errorCodes.coreApprovalPolicyInvalid,
            details: { mode: policy.mode },
            message: `Approval policy mode ${String(policy.mode)} is invalid.`,
            retryable: false,
        });
    }
    for (const rule of policy.rules ?? []) {
        if (rule.match !== "exact") {
            throw createError({
                code: errorCodes.coreApprovalPolicyInvalid,
                details: { match: rule.match },
                message: `Approval policy match ${String(rule.match)} is invalid.`,
                retryable: false,
            });
        }
        if (
            (rule.source === "all" || rule.source === source) &&
            (rule.toolName === undefined || rule.toolName === tool)
        ) {
            return rule.decision;
        }
    }
    return policy.mode === "ask"
        ? "ask"
        : policy.mode === "deny"
          ? "deny"
          : "allow";
}

function notFound(instance: InstanceName, approvalId: string) {
    return createError({
        code: errorCodes.coreApprovalNotFound,
        details: { approvalId, instance },
        message: `Approval ${approvalId} was not found for instance ${instance}.`,
        retryable: false,
    });
}

function denied(instance: InstanceName, toolName: string) {
    return new ApprovalError(
        errorCodes.coreApprovalDenied,
        `Approval denied for ${toolName} on instance ${instance}.`,
        { instance, toolName },
    );
}

function expired(instance: InstanceName, toolName: string) {
    return new ApprovalError(
        errorCodes.coreApprovalExpired,
        `Approval expired for ${toolName} on instance ${instance}.`,
        { instance, toolName },
    );
}

function cancelled(instance: InstanceName, toolName: string, reason?: string) {
    return new ApprovalError(
        errorCodes.coreToolCallCancelled,
        `Approval wait cancelled for ${toolName} on instance ${instance}.`,
        { instance, reason: reason ?? "client cancelled", toolName },
    );
}
