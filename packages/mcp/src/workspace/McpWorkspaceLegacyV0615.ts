import { randomUUID } from "node:crypto";

import type { GoalContinuationInput, JsonValue, ToolCallContext, WaitRecord } from "@portable-devshell/shared";

import type { McpContextRegistry } from "../context/McpContextRegistry.js";
import {
    isMcpGoalGateway,
    isMcpInteractionGateway,
    isMcpWaitRecoveryGateway,
    isMcpWorkspaceGateway,
    type McpInstanceGateway,
    type McpInteractionGateway,
} from "../instance/McpInstanceGateway.js";
import { assertWorkspaceWaitRecoveryAssociationAvailable } from "./McpWorkspaceReentryArbiter.js";

export class McpWorkspaceLegacyV0615 {
    constructor(private readonly options: {
        contextRegistry?: McpContextRegistry;
        gateway?: McpInstanceGateway;
        instanceName: string;
    }) {}

    async call(toolName: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireInteractionGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "workspace_wait_recover":
                return await this.#recoverWait(gateway, input, context);
            case "workspace_goal_continue":
                return await this.#continueGoal(gateway, input, context);
            case "workspace_reentry_control":
                return await this.#controlReentry(input, context);
            default:
                throw new Error(`Unsupported v0.6.15 Workspace app tool: ${toolName}.`);
        }
    }

    async #controlReentry(input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const registry = this.options.contextRegistry;
        if (registry === undefined) throw new Error("Workspace re-entry arbitration is unavailable.");
        const ctxId = requireCtxId(context);
        const request = readReentryControl(input);
        if (request.action === "get") {
            return await registry.readAutomaticReentry(ctxId, this.options.instanceName) as unknown as JsonValue;
        }
        if (request.action === "yield") {
            const state = await registry.suppressAutomaticReentry(
                ctxId,
                this.options.instanceName,
                request.reason ?? "user interrupted automatic execution",
            );
            return { ...state, suppressed: true } as unknown as JsonValue;
        }
        if (request.action === "resume") {
            const state = await registry.resumeAutomaticReentry(ctxId, this.options.instanceName);
            return { ...state, resumed: true } as unknown as JsonValue;
        }
        if (request.action === "claim") {
            const claimId = request.claimId ?? `workspace-reentry-${randomUUID()}`;
            const result = await registry.claimAutomaticReentry(ctxId, this.options.instanceName, claimId);
            return { ...result.state, claimed: result.claimed, claimId } as unknown as JsonValue;
        }
        if (request.action === "validate") {
            if (request.claimId === undefined) throw new Error("workspace_reentry_control validate requires claimId.");
            const result = await registry.validateAutomaticReentry(ctxId, this.options.instanceName, request.claimId);
            return { ...result.state, valid: result.valid } as unknown as JsonValue;
        }
        if (request.claimId === undefined) throw new Error("workspace_reentry_control release requires claimId.");
        const state = await registry.releaseAutomaticReentry(ctxId, this.options.instanceName, request.claimId);
        return { ...state, released: true } as unknown as JsonValue;
    }

    async #continueGoal(
        interactionGateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const goalGateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
        const ctxId = requireCtxId(context);
        const request = readGoalContinuationInput(input);
        if (request.action !== "report" && request.action !== "reset") {
            const workspaceGateway = isMcpWorkspaceGateway(interactionGateway) ? interactionGateway : undefined;
            const instances = await this.#contextInstances(ctxId);
            const [goal, waits, approvalSlices, activeCallSlices] = await Promise.all([
                goalGateway.readGoal(this.options.instanceName, ctxId),
                interactionGateway.listWaits(this.options.instanceName),
                Promise.allSettled(instances.map(async (instance) =>
                    interactionGateway.listPendingApprovals === undefined
                        ? (await interactionGateway.listApprovals(instance)).filter((approval) => approval.status === "pending")
                        : await interactionGateway.listPendingApprovals(instance, ctxId)
                )),
                Promise.allSettled(instances.map(async (instance) => {
                    if (workspaceGateway?.hasActiveToolCalls !== undefined) {
                        return workspaceGateway.hasActiveToolCalls(instance, ctxId);
                    }
                    const calls = await (workspaceGateway?.readToolCalls(instance, ctxId, 64) ?? []);
                    return calls.some((call) =>
                        call.status === "queued" || call.status === "pendingApproval" || call.status === "running"
                    );
                })),
            ]);
            const approvals = approvalSlices.flatMap((result) => result.status === "fulfilled" ? result.value : []);
            request.available = request.available !== false &&
                !waits.some((wait) => (
                    wait.createdByCtxId === ctxId && wait.goalId === goal?.goalId &&
                    wait.automaticRecovery !== false && wait.recoveryDisabledAt === undefined &&
                    wait.status !== "consumed" && wait.status !== "cancelled"
                )) &&
                !approvals.some((approval) => approval.ctxId === ctxId && approval.status === "pending") &&
                !activeCallSlices.some((result) => result.status === "fulfilled" && result.value);
        }
        return await goalGateway.goalContinuation(this.options.instanceName, request, ctxId);
    }

    async #recoverWait(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        if (!isMcpWaitRecoveryGateway(gateway)) {
            throw new Error(`Workspace recovery is unavailable for ${this.options.instanceName}.`);
        }
        const recovery = readWaitRecovery(input);
        const wait = (await gateway.listWaits(this.options.instanceName)).find((entry) => entry.waitId === recovery.waitId);
        if (
            wait === undefined || wait.createdByCtxId !== requireCtxId(context) ||
            (wait.kind !== "tmux" && wait.kind !== "question") || wait.detachedAt === undefined
        ) {
            throw new Error(`Recoverable detached wait ${recovery.waitId} was not found for the current Context.`);
        }
        if (wait.status === "consumed") return completedWaitCompatibility(wait, recovery.action);
        if (wait.status !== "resolved") {
            throw new Error(`Recoverable detached wait ${recovery.waitId} was not found for the current Context.`);
        }
        if (recovery.action === "dismiss") {
            const dismissed = await gateway.dismissWaitRecovery(
                this.options.instanceName,
                recovery.waitId,
                recovery.recoveryMessageId,
            );
            return { dismissed: true, kind: dismissed.kind, targetId: dismissed.targetId, waitId: dismissed.waitId };
        }
        if (recovery.action === "attempt") {
            await assertWorkspaceWaitRecoveryAssociationAvailable(this.options, wait, context);
            const attempted = await gateway.markWaitRecoveryAttempted(this.options.instanceName, recovery.waitId, recovery.claimId);
            return {
                attempted: true,
                ...(attempted.recoveryMessageAttemptedAt === undefined ? {} : { recoveryMessageAttemptedAt: attempted.recoveryMessageAttemptedAt }),
                ...(attempted.recoveryMessageId === undefined ? {} : { recoveryMessageId: attempted.recoveryMessageId }),
                waitId: attempted.waitId,
            };
        }
        if (recovery.action === "sent") {
            const sent = await gateway.completeWaitRecovery(this.options.instanceName, recovery.waitId, recovery.claimId);
            if (sent.goalId !== undefined && this.options.gateway?.recordGoalReentry !== undefined) {
                await this.options.gateway.recordGoalReentry(
                    this.options.instanceName,
                    requireCtxId(context),
                    sent.recoveryGoalProgressEpoch ?? sent.goalProgressEpoch,
                );
            }
            return sentWaitCompatibility(sent);
        }
        if (recovery.action === "release") {
            await gateway.releaseWaitRecovery(this.options.instanceName, recovery.waitId, recovery.claimId);
            return { released: true, waitId: recovery.waitId };
        }
        if (recovery.action === "reject") {
            await gateway.rejectWaitRecovery(this.options.instanceName, recovery.waitId, recovery.claimId);
            return { rejected: true, waitId: recovery.waitId };
        }
        if (recovery.action === "complete") {
            const consumed = await gateway.completeWaitRecovery(this.options.instanceName, recovery.waitId, recovery.claimId);
            return { completed: true, kind: consumed.kind, targetId: consumed.targetId, waitId: consumed.waitId };
        }
        await assertWorkspaceWaitRecoveryAssociationAvailable(this.options, wait, context);
        const claimId = `recovery-${randomUUID()}`;
        const claimed = await gateway.claimWaitRecovery(this.options.instanceName, recovery.waitId, claimId);
        return {
            claimId,
            ...(claimed.goalId === undefined ? {} : { goalId: claimed.goalId }),
            kind: claimed.kind,
            ...(claimed.result === undefined ? {} : { result: claimed.result }),
            ...(claimed.recoveryMessageAttemptedAt === undefined ? {} : { recoveryMessageAttemptedAt: claimed.recoveryMessageAttemptedAt }),
            ...(claimed.recoveryMessageId === undefined ? {} : { recoveryMessageId: claimed.recoveryMessageId }),
            ...(claimed.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: claimed.recoveryMessageSentAt }),
            ...(claimed.taskId === undefined ? {} : { taskId: claimed.taskId }),
            targetId: claimed.targetId,
            waitId: claimed.waitId,
        };
    }

    async #contextInstances(ctxId: string): Promise<string[]> {
        const registry = this.options.contextRegistry;
        if (registry === undefined) return [this.options.instanceName];
        const record = await registry.validateForInstance(ctxId, this.options.instanceName);
        return [...new Set([this.options.instanceName, ...record.environments.map((environment) => environment.instance)])];
    }
}

function completedWaitCompatibility(wait: WaitRecord, action: string): JsonValue {
    if (action === "release") return { released: true, waitId: wait.waitId };
    if (action === "complete") {
        return { completed: true, kind: wait.kind, targetId: wait.targetId, waitId: wait.waitId };
    }
    if (action === "sent") return sentWaitCompatibility(wait);
    throw new Error(`Wait ${wait.waitId} recovery was already consumed.`);
}

function sentWaitCompatibility(wait: WaitRecord): JsonValue {
    return {
        ...(wait.recoveryMessageAttemptedAt === undefined ? {} : { recoveryMessageAttemptedAt: wait.recoveryMessageAttemptedAt }),
        ...(wait.recoveryMessageId === undefined ? {} : { recoveryMessageId: wait.recoveryMessageId }),
        ...(wait.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: wait.recoveryMessageSentAt }),
        sent: true,
        waitId: wait.waitId,
    };
}

function readGoalContinuationInput(input: JsonValue): GoalContinuationInput {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_goal_continue requires an object input.");
    const action = record.action;
    if (action !== "claim" && action !== "validate" && action !== "attempt" && action !== "report" && action !== "reset") {
        throw new Error("workspace_goal_continue action must be claim, validate, attempt, report, or reset.");
    }
    const request: GoalContinuationInput = { action };
    if (record.available !== undefined) {
        if (typeof record.available !== "boolean") throw new Error("available must be a boolean.");
        request.available = record.available;
    }
    if (record.accepted !== undefined) {
        if (typeof record.accepted !== "boolean") throw new Error("accepted must be a boolean.");
        request.accepted = record.accepted;
    }
    if (record.claimId !== undefined) request.claimId = text(record.claimId, "claimId");
    if (record.error !== undefined) request.error = text(record.error, "error");
    return request;
}

function readReentryControl(input: JsonValue): {
    action: "get" | "yield" | "resume" | "claim" | "validate" | "release";
    claimId?: string;
    reason?: string;
} {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_reentry_control requires an object input.");
    const action = record.action;
    if (action !== "get" && action !== "yield" && action !== "resume" && action !== "claim" && action !== "validate" && action !== "release") {
        throw new Error("workspace_reentry_control action must be get, yield, resume, claim, validate, or release.");
    }
    return {
        action,
        ...(record.claimId === undefined ? {} : { claimId: text(record.claimId, "claimId") }),
        ...(record.reason === undefined ? {} : { reason: text(record.reason, "reason") }),
    };
}

function readWaitRecovery(input: JsonValue):
    | { action: "claim"; waitId: string }
    | { action: "dismiss"; recoveryMessageId: string; waitId: string }
    | { action: "attempt" | "complete" | "release" | "reject" | "sent"; claimId: string; waitId: string } {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_wait_recover requires an object input.");
    const action = record.action;
    const waitId = text(record.waitId, "waitId");
    if (action === "claim") return { action, waitId };
    if (action === "dismiss") {
        return { action, recoveryMessageId: text(record.recoveryMessageId, "recoveryMessageId"), waitId };
    }
    if (action === "attempt" || action === "complete" || action === "release" || action === "reject" || action === "sent") {
        return { action, claimId: text(record.claimId, "claimId"), waitId };
    }
    throw new Error("workspace_wait_recover action must be claim, attempt, sent, complete, release, reject, or dismiss.");
}

function requireCtxId(context: ToolCallContext): string {
    if (typeof context.ctxId !== "string" || context.ctxId.length === 0) {
        throw new Error("Interaction tool requires a validated Context.");
    }
    return context.ctxId;
}

function requireGoalGateway(gateway: McpInstanceGateway | undefined, instance: string) {
    if (!isMcpGoalGateway(gateway)) throw new Error(`Workspace Goal is unavailable for ${instance}.`);
    return gateway;
}

function requireInteractionGateway(gateway: McpInstanceGateway | undefined, instance: string): McpInteractionGateway {
    if (!isMcpInteractionGateway(gateway)) throw new Error(`Workspace interaction is unavailable for ${instance}.`);
    return gateway;
}

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return value.trim();
}

function asRecord(value: unknown): { [key: string]: JsonValue } | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as { [key: string]: JsonValue }
        : undefined;
}
