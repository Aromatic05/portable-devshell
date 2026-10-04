import { randomUUID } from "node:crypto";
import {
    createRemoteError,
    runtimeErrorCodes,
    type ApprovalDecision,
    type ApprovalDecisionBy,
    type ApprovalEventType,
    type ApprovalRequest,
    type ApprovalTimeout,
    type InstanceName,
    type JsonValue,
} from "@portable-devshell/shared";
import type { ApprovalPolicy } from "@portable-devshell/shared/config";
import type {
    ApprovalEvaluation,
    ApprovalEvaluationInput,
    ApprovalResolution,
} from "./Api.js";

type ApprovalPolicyDecision = Exclude<ApprovalPolicy["mode"], "disabled">;

const TERMINAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL_MAX_COUNT = 1000;

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

export interface ApprovalStorePort {
    append(request: ApprovalRequest): Promise<void>;
    close?(): void;
    delete(approvalId: string): Promise<void>;
    get(approvalId: string): Promise<ApprovalRequest | undefined>;
    list(): Promise<ApprovalRequest[]>;
}

export interface ApprovalEventPort {
    append(
        type: ApprovalEventType,
        data: Record<string, JsonValue>,
    ): Promise<unknown>;
}

export interface ApprovalServiceOptions {
    instanceName: InstanceName;
    store: ApprovalStorePort;
    events: ApprovalEventPort;
    policy?: ApprovalPolicy;
    timeout?: ApprovalTimeout;
    now?: () => number;
    createId?: () => string;
}

interface PendingApproval {
    request: ApprovalRequest;
    resolve: (value: ApprovalResolution) => void;
    timeout: NodeJS.Timeout;
    removeAbortListener?: () => void;
}

export class ApprovalService {
    readonly #instance: InstanceName;
    readonly #store: ApprovalStorePort;
    readonly #events: ApprovalEventPort;
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
        this.#events = options.events;
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
            pending.removeAbortListener?.();
            pending.resolve({
                error: cancelled(this.#instance, pending.request.toolName),
                status: "cancelled",
            });
        }
        this.#pending.clear();
        this.#store.close?.();
    }

    async evaluate(
        input: ApprovalEvaluationInput,
        signal?: AbortSignal,
    ): Promise<ApprovalEvaluation> {
        await this.#ensureReady();
        return this.#exclusive(async () => {
            const outcome = policyDecision(
                this.#policy,
                input.source,
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
                ...(input.requestId === undefined
                    ? {}
                    : { requestId: input.requestId }),
                riskLevel: "medium",
                ...(input.ctxId === undefined ? {} : { ctxId: input.ctxId }),
                source: input.source,
                status: "pending",
                toolName: input.toolName,
                ...(input.workspace === undefined
                    ? {}
                    : { workspace: input.workspace }),
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
            if (signal !== undefined) {
                const cancelPending = () => {
                    void this.cancel(
                        request.approvalId,
                        abortReason(signal.reason),
                    ).catch(() => undefined);
                };
                pending.removeAbortListener = () => {
                    signal.removeEventListener("abort", cancelPending);
                };
                if (signal.aborted) cancelPending();
                else
                    signal.addEventListener("abort", cancelPending, {
                        once: true,
                    });
            }
            await this.#events.append("approval.requested", eventData(request));
            return { decision: "ask", request, awaitDecision };
        });
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        await this.#ensureReady();
        return this.#exclusive(async () => {
            await this.#pruneTerminal();
            return this.#store.list();
        });
    }

    async listPendingApprovals(ctxId?: string): Promise<ApprovalRequest[]> {
        await this.#ensureReady();
        return [...this.#pending.values()]
            .map(({ request }) => request)
            .filter(
                (request) => ctxId === undefined || request.ctxId === ctxId,
            );
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
            if (request === undefined)
                throw notFound(this.#instance, approvalId);
            if (request.status !== "pending") {
                throw createRemoteError({
                    code: runtimeErrorCodes.approvalAlreadyDecided,
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
                terminalAt: decision.decidedAt,
            };
            await this.#complete(
                updated,
                input.decision === "approve"
                    ? { decision, status: "approved" }
                    : {
                          decision,
                          error: denied(this.#instance, request.toolName),
                          status: "denied",
                      },
            );
            await this.#pruneTerminal();
            return updated;
        });
    }

    async cancel(
        approvalId: string,
        reason?: string,
    ): Promise<ApprovalRequest> {
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

        const updated = {
            ...request,
            status: "cancelled" as const,
            terminalAt: new Date(this.#now()).toISOString(),
        };
        await this.#complete(
            updated,
            {
                error: cancelled(this.#instance, request.toolName, reason),
                status: "cancelled",
            },
            reason,
        );
        await this.#pruneTerminal();
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
                    const terminalAt =
                        status === "expired"
                            ? request.expiresAt
                            : new Date(this.#now()).toISOString();
                    await this.#complete(
                        { ...request, status, terminalAt },
                        {
                            error:
                                status === "expired"
                                    ? expired(this.#instance, request.toolName)
                                    : cancelled(
                                          this.#instance,
                                          request.toolName,
                                      ),
                            status,
                        },
                    );
                }
                await this.#pruneTerminal();
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
            void this.#expire(id).catch(() => {
                if (this.#pending.get(id) === pending) {
                    this.#arm(
                        id,
                        pending,
                        Math.min(1000, Math.max(1, this.#timeoutMs)),
                    );
                }
            });
        }, delay);
    }

    async #expire(id: string): Promise<void> {
        await this.#exclusive(async () => {
            const pending = this.#pending.get(id);
            if (pending === undefined) return;
            const request = {
                ...pending.request,
                status: "expired" as const,
                terminalAt: pending.request.expiresAt,
            };
            await this.#complete(request, {
                error: expired(this.#instance, request.toolName),
                status: "expired",
            });
            await this.#pruneTerminal();
        });
    }

    async #pruneTerminal(): Promise<void> {
        const cutoff = this.#now() - TERMINAL_MAX_AGE_MS;
        const terminals = (await this.#store.list())
            .filter((request) => request.status !== "pending")
            .map((request) => ({
                request,
                time: Date.parse(
                    request.terminalAt ??
                        request.decision?.decidedAt ??
                        (request.status === "expired"
                            ? request.expiresAt
                            : request.createdAt),
                ),
            }))
            .sort(
                (left, right) =>
                    left.time - right.time ||
                    left.request.approvalId.localeCompare(
                        right.request.approvalId,
                    ) ||
                    left.request.createdAt.localeCompare(
                        right.request.createdAt,
                    ),
            );
        const retained: ApprovalRequest[] = [];
        for (const { request, time } of terminals) {
            if (time < cutoff) await this.#store.delete(request.approvalId);
            else retained.push(request);
        }
        for (const request of retained.slice(
            0,
            Math.max(0, retained.length - TERMINAL_MAX_COUNT),
        )) {
            await this.#store.delete(request.approvalId);
        }
    }

    async #complete(
        request: ApprovalRequest,
        resolution: ApprovalResolution,
        reason?: string,
    ): Promise<void> {
        await this.#store.append(request);
        const pending = this.#pending.get(request.approvalId);
        if (pending !== undefined) {
            clearTimeout(pending.timeout);
            pending.removeAbortListener?.();
            this.#pending.delete(request.approvalId);
        }
        try {
            await this.#events.append(
                `approval.${resolution.status}`,
                eventData(request, request.decision, reason),
            );
        } finally {
            pending?.resolve(resolution);
        }
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
    source: ApprovalRequest["source"],
    tool: string,
): ApprovalPolicyDecision {
    if (!["disabled", "allow", "ask", "deny"].includes(policy.mode)) {
        throw createRemoteError({
            code: runtimeErrorCodes.approvalPolicyInvalid,
            details: { mode: policy.mode },
            message: `Approval policy mode ${String(policy.mode)} is invalid.`,
            retryable: false,
        });
    }
    for (const rule of policy.rules ?? []) {
        if (rule.match !== "exact") {
            throw createRemoteError({
                code: runtimeErrorCodes.approvalPolicyInvalid,
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
    return createRemoteError({
        code: runtimeErrorCodes.approvalNotFound,
        details: { approvalId, instance },
        message: `Approval ${approvalId} was not found for instance ${instance}.`,
        retryable: false,
    });
}

function denied(instance: InstanceName, toolName: string) {
    return new ApprovalError(
        runtimeErrorCodes.approvalDenied,
        `Approval denied for ${toolName} on instance ${instance}.`,
        { instance, toolName },
    );
}

function expired(instance: InstanceName, toolName: string) {
    return new ApprovalError(
        runtimeErrorCodes.approvalExpired,
        `Approval expired for ${toolName} on instance ${instance}.`,
        { instance, toolName },
    );
}

function cancelled(instance: InstanceName, toolName: string, reason?: string) {
    return new ApprovalError(
        runtimeErrorCodes.toolCallCancelled,
        `Approval wait cancelled for ${toolName} on instance ${instance}.`,
        { instance, reason: reason ?? "client cancelled", toolName },
    );
}

function abortReason(reason: unknown): string {
    if (reason instanceof Error && reason.message.length > 0) {
        return reason.message;
    }
    if (typeof reason === "string" && reason.length > 0) return reason;
    return "ToolCall was cancelled while awaiting approval.";
}

function eventData(
    request: ApprovalRequest,
    decision?: ApprovalDecision,
    reason?: string,
): Record<string, JsonValue> {
    const fields: Record<string, JsonValue | undefined> = {
        approvalId: request.approvalId,
        callId: request.callId,
        createdAt: request.createdAt,
        decidedAt: decision?.decidedAt,
        decidedBy: decision?.decidedBy,
        decision: decision?.decision,
        expiresAt: request.expiresAt,
        inputSummary: request.inputSummary,
        reason: reason ?? decision?.reason ?? request.reason,
        recording: request.recording,
        requestId: request.requestId,
        remember: decision?.remember,
        riskLevel: request.riskLevel,
        ctxId: request.ctxId,
        extensionId: request.extensionId,
        source: request.source,
        status: request.status,
        terminalAt: request.terminalAt,
        toolName: request.toolName,
        workspace: request.workspace,
    };
    return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as Record<string, JsonValue>;
}
