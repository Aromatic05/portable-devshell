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
    type ToolCallContext
} from "@portable-devshell/shared";

import { JsonlStore } from "../log/store/LogStoreJsonl.js";

export class ApprovalError extends Error {
    readonly code: string;
    readonly details?: JsonValue;
    readonly retryable = false;

    constructor(code: string, message: string, details?: JsonValue) {
        super(message);
        this.name = "ApprovalError";
        this.code = code;
        this.details = details;
    }
}

export class ApprovalStore {
    readonly #store: JsonlStore<ApprovalRequest>;

    constructor(store: JsonlStore<ApprovalRequest>) {
        this.#store = store;
    }

    async append(request: ApprovalRequest): Promise<void> {
        await this.#store.append(request);
    }

    async get(approvalId: string): Promise<ApprovalRequest | undefined> {
        return toLatestRequests(await this.#store.readAll()).find((request) => request.approvalId === approvalId);
    }

    async list(): Promise<ApprovalRequest[]> {
        return toLatestRequests(await this.#store.readAll());
    }
}

export interface ApprovalEvaluationInput {
    callId: string;
    context: ToolCallContext;
    inputSummary: string;
    toolName: string;
}

export type ApprovalEvaluation =
    | {
          decision: "allow";
      }
    | {
          decision: "deny";
          error: ApprovalError;
      }
    | {
          awaitDecision: Promise<ApprovalResolution>;
          decision: "ask";
          request: ApprovalRequest;
      };

export type ApprovalResolution =
    | {
          decision: ApprovalDecision;
          status: "approved";
      }
    | {
          decision: ApprovalDecision;
          error: ApprovalError;
          status: "denied";
      }
    | {
          error: ApprovalError;
          status: "expired";
      };

interface ApprovalManagerOptions {
    instanceName: InstanceName;
    policy?: ApprovalPolicy;
    store: ApprovalStore;
    timeout?: ApprovalTimeout;
}

export class ApprovalManager {
    readonly #instanceName: InstanceName;
    #policy: ApprovalPolicy;
    readonly #store: ApprovalStore;
    readonly #timeoutMs: number;
    readonly #pending = new Map<
        string,
        {
            request: ApprovalRequest;
            resolve: (resolution: ApprovalResolution) => void;
            timeout: NodeJS.Timeout;
        }
    >();

    constructor(options: ApprovalManagerOptions) {
        this.#instanceName = options.instanceName;
        this.#policy = options.policy ?? { mode: "disabled" };
        this.#store = options.store;
        this.#timeoutMs = options.timeout?.ms ?? 300_000;
    }

    async evaluate(input: ApprovalEvaluationInput): Promise<ApprovalEvaluation> {
        const policyDecision = resolvePolicyDecision(this.#policy, input.context.source, input.toolName);

        if (policyDecision === "allow") {
            return { decision: "allow" };
        }

        if (policyDecision === "deny") {
            return {
                decision: "deny",
                error: createApprovalDeniedError(this.#instanceName, input.toolName)
            };
        }

        const createdAt = new Date().toISOString();
        const request: ApprovalRequest = {
            approvalId: randomUUID(),
            callId: input.callId,
            createdAt,
            expiresAt: new Date(Date.now() + this.#timeoutMs).toISOString(),
            inputSummary: input.inputSummary,
            instance: this.#instanceName,
            reason: `Approval required before running ${input.toolName}.`,
            ...(input.context.requestId === undefined ? {} : { requestId: input.context.requestId }),
            riskLevel: "medium",
            ...(input.context.sessionId === undefined ? {} : { sessionId: input.context.sessionId }),
            source: input.context.source,
            status: "pending",
            toolName: input.toolName
        };

        await this.#store.append(request);

        const awaitDecision = new Promise<ApprovalResolution>((resolve) => {
            const timeout = setTimeout(() => {
                void this.#expire(request.approvalId).then(resolve);
            }, this.#timeoutMs);
            timeout.unref?.();
            this.#pending.set(request.approvalId, {
                request,
                resolve,
                timeout
            });
        });

        return {
            awaitDecision,
            decision: "ask",
            request
        };
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        return await this.#store.list();
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        const request = await this.#store.get(approvalId);
        if (request !== undefined) {
            return request;
        }

        throw createError({
            code: errorCodes.coreApprovalNotFound,
            details: { approvalId, instance: this.#instanceName },
            message: `Approval ${approvalId} was not found for instance ${this.#instanceName}.`,
            retryable: false
        });
    }

    async decideApproval(
        approvalId: string,
        input: {
            decision: "approve" | "deny";
            decidedBy: ApprovalDecisionBy;
            policyPatch?: JsonValue;
            reason?: string;
            remember?: boolean;
        }
    ): Promise<ApprovalRequest> {
        const pending = this.#pending.get(approvalId);
        const request = pending?.request ?? (await this.#store.get(approvalId));

        if (request === undefined) {
            throw createError({
                code: errorCodes.coreApprovalNotFound,
                details: { approvalId, instance: this.#instanceName },
                message: `Approval ${approvalId} was not found for instance ${this.#instanceName}.`,
                retryable: false
            });
        }

        if (request.status !== "pending") {
            throw createError({
                code: errorCodes.coreApprovalAlreadyDecided,
                details: { approvalId, instance: this.#instanceName, status: request.status },
                message: `Approval ${approvalId} was already decided.`,
                retryable: false
            });
        }

        const decision: ApprovalDecision = {
            approvalId,
            decidedAt: new Date().toISOString(),
            decidedBy: input.decidedBy,
            decision: input.decision,
            ...(input.policyPatch === undefined ? {} : { policyPatch: input.policyPatch }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.remember === undefined ? {} : { remember: input.remember })
        };
        const resolvedRequest: ApprovalRequest = {
            ...request,
            decision,
            status: input.decision === "approve" ? "approved" : "denied"
        };

        await this.#store.append(resolvedRequest);

        if (pending !== undefined) {
            clearTimeout(pending.timeout);
            this.#pending.delete(approvalId);
            pending.resolve(
                input.decision === "approve"
                    ? {
                          decision,
                          status: "approved"
                      }
                    : {
                          decision,
                          error: createApprovalDeniedError(this.#instanceName, request.toolName),
                          status: "denied"
                      }
            );
        }

        return resolvedRequest;
    }

    setPolicy(policy: ApprovalPolicy | undefined): void {
        this.#policy = policy ?? { mode: "disabled" };
    }

    async #expire(approvalId: string): Promise<ApprovalResolution> {
        const pending = this.#pending.get(approvalId);
        if (pending === undefined) {
            const request = await this.#store.get(approvalId);
            return {
                error: createApprovalExpiredError(this.#instanceName, request?.toolName ?? "unknown"),
                status: "expired"
            };
        }

        this.#pending.delete(approvalId);
        const expiredRequest: ApprovalRequest = {
            ...pending.request,
            status: "expired"
        };
        await this.#store.append(expiredRequest);

        return {
            error: createApprovalExpiredError(this.#instanceName, pending.request.toolName),
            status: "expired"
        };
    }
}

function resolvePolicyDecision(policy: ApprovalPolicy, source: ToolCallContext["source"], toolName: string): ApprovalPolicyDecision {
    if (policy.mode !== "disabled" && policy.mode !== "allow" && policy.mode !== "ask" && policy.mode !== "deny") {
        throw createError({
            code: errorCodes.coreApprovalPolicyInvalid,
            details: { mode: policy.mode },
            message: `Approval policy mode ${String(policy.mode)} is invalid.`,
            retryable: false
        });
    }

    for (const rule of policy.rules ?? []) {
        if (rule.match !== "exact") {
            throw createError({
                code: errorCodes.coreApprovalPolicyInvalid,
                details: {
                    match: rule.match,
                    ...(rule.toolName === undefined ? {} : { toolName: rule.toolName })
                },
                message: `Approval policy match ${String(rule.match)} is invalid.`,
                retryable: false
            });
        }

        if (rule.source !== "all" && rule.source !== source) {
            continue;
        }

        if (rule.toolName !== undefined && rule.toolName !== toolName) {
            continue;
        }

        return rule.decision;
    }

    switch (policy.mode) {
        case "disabled":
        case "allow":
            return "allow";
        case "ask":
            return "ask";
        case "deny":
            return "deny";
    }
}

function toLatestRequests(records: ApprovalRequest[]): ApprovalRequest[] {
    const latest = new Map<string, ApprovalRequest>();

    for (const record of records) {
        latest.set(record.approvalId, record);
    }

    return [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function createApprovalDeniedError(instanceName: InstanceName, toolName: string): ApprovalError {
    return new ApprovalError(
        errorCodes.coreApprovalDenied,
        `Approval denied for ${toolName} on instance ${instanceName}.`,
        {
            instance: instanceName,
            toolName
        }
    );
}

function createApprovalExpiredError(instanceName: InstanceName, toolName: string): ApprovalError {
    return new ApprovalError(
        errorCodes.coreApprovalExpired,
        `Approval expired for ${toolName} on instance ${instanceName}.`,
        {
            instance: instanceName,
            toolName
        }
    );
}
