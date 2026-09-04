import { randomUUID } from "node:crypto";

import type { JsonValue, ToolCallContext, WaitRecord } from "@portable-devshell/shared";

import type { McpContextRegistry } from "../context/McpContextRegistry.js";
import {
    isMcpGoalGateway,
    isMcpInteractionGateway,
    isMcpWaitRecoveryGateway,
    type McpInstanceGateway,
    type McpInteractionGateway,
} from "../instance/McpInstanceGateway.js";
import {
    explicitReentryDelivery,
    goalReentryDelivery,
    waitReentryDelivery,
    type WorkspaceExplicitReentryKind,
    type WorkspaceReentryDelivery,
} from "./McpWorkspaceReentry.js";
import { readWorkspaceSnapshot } from "./McpWorkspaceSnapshot.js";

export async function assertWorkspaceWaitRecoveryAssociationAvailable(
    options: { gateway?: McpInstanceGateway; instanceName: string },
    wait: WaitRecord,
    context: ToolCallContext,
): Promise<void> {
    const gateway = requireInteractionGateway(options.gateway, options.instanceName);
    const ctxId = requireCtxId(context);
    const explicitHumanResume = wait.kind === "question" || asRecord(wait.result)?.interrupted === true;
    if (wait.recoveryDisabledAt !== undefined || (wait.automaticRecovery === false && !explicitHumanResume)) {
        throw new Error(`Wait ${wait.waitId} is not available for automatic recovery.`);
    }
    if (wait.workspace !== undefined && context.workspace !== undefined && wait.workspace !== context.workspace) {
        throw new Error(`Wait ${wait.waitId} belongs to another workspace.`);
    }
    if (wait.goalId !== undefined) {
        const goalGateway = requireGoalGateway(options.gateway, options.instanceName);
        const goal = await goalGateway.readGoal(options.instanceName, ctxId);
        if (
            goal?.goalId !== wait.goalId ||
            (goal.status !== "active" && !(goal.status === "blocked" && explicitHumanResume))
        ) {
            throw new Error(`Workspace Goal ${wait.goalId} is not available for automatic recovery.`);
        }
        if (wait.workspace !== undefined && goal.workspace !== undefined && wait.workspace !== goal.workspace) {
            throw new Error(`Workspace Goal ${wait.goalId} moved to another workspace.`);
        }
        if (wait.goalStepId !== undefined) {
            const step = goal.steps.find((candidate) => candidate.id === wait.goalStepId);
            if (step === undefined || step.status !== "active") {
                throw new Error(`Workspace Goal step ${wait.goalStepId} is no longer available for automatic recovery.`);
            }
        } else if (wait.goalProgressAt !== undefined && goal.lastProgressAt !== wait.goalProgressAt) {
            throw new Error(`Workspace Goal ${wait.goalId} progressed since wait ${wait.waitId} was created.`);
        } else if (wait.goalProgressAt === undefined && wait.goalRevision !== undefined && goal.revision !== wait.goalRevision) {
            throw new Error(`Workspace Goal ${wait.goalId} changed since wait ${wait.waitId} was created.`);
        }
        return;
    }
    if (wait.taskId === undefined) return;
    const todo = asRecord(await gateway.readTodo(options.instanceName, { taskId: wait.taskId }));
    const task = Array.isArray(todo?.tasks)
        ? todo.tasks.map(asRecord).find((entry) => entry?.taskId === wait.taskId && entry?.ctxId === ctxId)
        : undefined;
    if (task === undefined || task.status !== "in_progress") {
        throw new Error(`Durable task ${wait.taskId} is not available for automatic recovery.`);
    }
    if (wait.todoItemId !== undefined) {
        const item = Array.isArray(todo?.items)
            ? todo.items.map(asRecord).find((entry) => entry?.id === wait.todoItemId)
            : undefined;
        if (item?.status !== "in_progress") {
            throw new Error(`Durable task item ${wait.todoItemId} is no longer available for automatic recovery.`);
        }
    } else if (wait.taskRevision !== undefined && todo?.revision !== wait.taskRevision) {
        throw new Error(`Durable task ${wait.taskId} changed since wait ${wait.waitId} was created.`);
    }
}

export class McpWorkspaceReentryArbiter {
    constructor(private readonly options: {
        contextRegistry: McpContextRegistry;
        gateway?: McpInstanceGateway;
        instanceName: string;
    }) {}

    async control(input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireInteractionGateway(this.options.gateway, this.options.instanceName);
        const ctxId = requireCtxId(context);
        const request = readReentryControl(input);
        const registry = this.options.contextRegistry;
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

        const claimId = request.claimId ?? `workspace-reentry-${randomUUID()}`;
        if (request.action === "claim") {
            if (request.intent !== undefined && request.intent !== "automatic") {
                if (request.sourceId === undefined) throw new Error("Explicit Workspace re-entry requires sourceId.");
                return await this.#claimExplicit(gateway, context, claimId, request.intent, request.sourceId);
            }
            return await this.#claimAutomatic(gateway, context, claimId);
        }
        if (request.action === "validate") return await this.#validate(gateway, context, claimId);
        if (request.action === "attempt") return await this.#attempt(gateway, context, claimId);
        if (request.action === "report") {
            if (request.outcome === undefined) throw new Error("workspace_reentry report requires outcome.");
            return await this.#report(gateway, context, claimId, request.outcome);
        }
        await this.#releaseSource(gateway, ctxId, claimId);
        const state = await registry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId);
        return { ...state, released: true } as unknown as JsonValue;
    }

    async observeExecutionStart(ctxId: string): Promise<number | undefined> {
        await this.#settleAttemptedFromExecution(ctxId);
        return (await this.options.contextRegistry.observeExecutionActivity(
            ctxId,
            this.options.instanceName,
        ).catch(() => undefined))?.executionEpoch;
    }

    async observeExecutionActivity(ctxId: string): Promise<void> {
        await this.options.contextRegistry.observeExecutionActivity(ctxId, this.options.instanceName).catch(() => undefined);
    }

    async releaseExecutionActivity(ctxId: string, executionEpoch: number | undefined): Promise<void> {
        if (executionEpoch === undefined) return;
        await this.options.contextRegistry.releaseExecutionActivity(
            ctxId,
            this.options.instanceName,
            executionEpoch,
        ).catch(() => undefined);
    }

    async executionActive(ctxId: string, ownerCallId?: string): Promise<boolean> {
        try {
            const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
            if (state.executionActive || state.attempted) return true;
        } catch {
            // A detached wait can outlive Context metadata; live tool calls remain the fallback signal.
        }
        return await this.#hasActiveToolCall(ctxId, ownerCallId);
    }

    async #claimAutomatic(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
        claimId: string,
    ): Promise<JsonValue> {
        const ctxId = requireCtxId(context);
        const arbitration = await this.#claimContext(gateway, ctxId, claimId);
        if (!arbitration.claimed) return { ...arbitration.state, claimed: false, claimId } as unknown as JsonValue;

        const waitDelivery = await this.#claimResolvedWaitDelivery(gateway, context, claimId);
        if (waitDelivery !== undefined) {
            const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
            return { ...state, claimed: true, claimId, delivery: waitDelivery } as unknown as JsonValue;
        }
        if (await this.#hasBlockingAutomaticWait(gateway, ctxId) || await this.#hasPendingContextApproval(gateway, ctxId)) {
            return await this.#releaseUnclaimedContext(ctxId, claimId);
        }

        const goalGateway = isMcpGoalGateway(this.options.gateway) ? this.options.gateway : undefined;
        if (goalGateway === undefined) return await this.#releaseUnclaimedContext(ctxId, claimId);
        const goal = await goalGateway.readGoal(this.options.instanceName, ctxId);
        if (goal?.continuationDue !== true) return await this.#releaseUnclaimedContext(ctxId, claimId);

        const claimedValue = await goalGateway.goalContinuation(
            this.options.instanceName,
            { action: "claim", available: true, claimId, goalId: goal.goalId },
            ctxId,
        );
        const claimed = asRecord(claimedValue);
        if (claimed?.claimed !== true) return await this.#releaseUnclaimedContext(ctxId, claimId);
        if (
            await this.#contextExecutionBusy(gateway, ctxId) ||
            await this.#hasBlockingAutomaticWait(gateway, ctxId) ||
            await this.#hasPendingContextApproval(gateway, ctxId)
        ) {
            await goalGateway.goalContinuation(
                this.options.instanceName,
                { action: "release", claimId, goalId: goal.goalId },
                ctxId,
            ).catch(() => undefined);
            if (await this.#contextExecutionBusy(gateway, ctxId)) {
                await this.#consumeResolvedWaitsDuringExecution(gateway, ctxId);
            }
            return await this.#releaseUnclaimedContext(ctxId, claimId);
        }

        const claimedGoal = await goalGateway.readGoal(this.options.instanceName, ctxId);
        if (claimedGoal === undefined) {
            await goalGateway.goalContinuation(
                this.options.instanceName,
                { action: "release", claimId, goalId: goal.goalId },
                ctxId,
            ).catch(() => undefined);
            return await this.#releaseUnclaimedContext(ctxId, claimId);
        }
        await this.options.contextRegistry.bindAutomaticReentrySource(
            ctxId,
            this.options.instanceName,
            claimId,
            "goal",
            claimedGoal.goalId,
        );
        const delivery = goalReentryDelivery(
            claimedGoal,
            typeof claimed.continuationCount === "number" ? claimed.continuationCount : undefined,
            await this.#workspaceSnapshot(gateway, ctxId),
        );
        const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
        return { ...state, claimed: true, claimId, delivery } as unknown as JsonValue;
    }

    async #claimExplicit(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
        claimId: string,
        intent: WorkspaceExplicitReentryKind,
        sourceId: string,
    ): Promise<JsonValue> {
        const ctxId = requireCtxId(context);
        const arbitration = await this.#claimContext(gateway, ctxId, claimId);
        if (!arbitration.claimed) return { ...arbitration.state, claimed: false, claimId } as unknown as JsonValue;

        const waitDelivery = await this.#claimResolvedWaitDelivery(gateway, context, claimId);
        if (waitDelivery !== undefined) {
            const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
            return { ...state, claimed: true, claimId, delivery: waitDelivery } as unknown as JsonValue;
        }
        if (
            await this.#hasBlockingAutomaticWait(gateway, ctxId) ||
            await this.#hasPendingContextApproval(gateway, ctxId)
        ) {
            return await this.#releaseUnclaimedContext(ctxId, claimId);
        }
        if (intent === "goal-retry") {
            try {
                await requireGoalGateway(this.options.gateway, this.options.instanceName).goalContinuation(
                    this.options.instanceName,
                    { action: "reset", goalId: sourceId },
                    ctxId,
                );
            } catch (error) {
                await this.options.contextRegistry.releaseAutomaticReentry(
                    ctxId,
                    this.options.instanceName,
                    claimId,
                ).catch(() => undefined);
                throw error;
            }
        }
        if (!await this.#explicitSourceAvailable(gateway, ctxId, intent, sourceId)) {
            return await this.#releaseUnclaimedContext(ctxId, claimId);
        }
        const state = await this.options.contextRegistry.bindAutomaticReentrySource(
            ctxId,
            this.options.instanceName,
            claimId,
            intent,
            sourceId,
        );
        return {
            ...state,
            claimed: true,
            claimId,
            delivery: explicitReentryDelivery(intent, sourceId, await this.#workspaceSnapshot(gateway, ctxId)),
        } as unknown as JsonValue;
    }

    async #claimContext(gateway: McpInteractionGateway, ctxId: string, claimId: string) {
        if (await this.#contextExecutionBusy(gateway, ctxId)) {
            await this.#consumeResolvedWaitsDuringExecution(gateway, ctxId);
            const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
            return { claimed: false as const, state };
        }
        if (await this.#hasPendingContextApproval(gateway, ctxId)) {
            const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
            return { claimed: false as const, state };
        }
        const arbitration = await this.options.contextRegistry.claimAutomaticReentry(
            ctxId,
            this.options.instanceName,
            claimId,
        );
        if (!arbitration.claimed) return { claimed: false as const, state: arbitration.state };
        if (await this.#contextExecutionBusy(gateway, ctxId)) {
            await this.#consumeResolvedWaitsDuringExecution(gateway, ctxId);
            const state = await this.options.contextRegistry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId);
            return { claimed: false as const, state };
        }
        if (await this.#hasPendingContextApproval(gateway, ctxId)) {
            const state = await this.options.contextRegistry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId);
            return { claimed: false as const, state };
        }
        return { claimed: true as const, state: arbitration.state };
    }

    async #validate(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
        claimId: string,
    ): Promise<JsonValue> {
        const ctxId = requireCtxId(context);
        const validation = await this.options.contextRegistry.validateAutomaticReentry(
            ctxId,
            this.options.instanceName,
            claimId,
        );
        if (!validation.valid) return { ...validation.state, valid: false } as unknown as JsonValue;

        const claimedWait = await this.#claimedWait(gateway, ctxId, claimId);
        const sourceKind = validation.state.sourceKind ?? (claimedWait === undefined ? "goal" : "wait");
        if (await this.#contextExecutionBusy(gateway, ctxId)) {
            if (claimedWait !== undefined) await gateway.consumeWait(this.options.instanceName, claimedWait.waitId).catch(() => undefined);
            else await this.#releaseSource(gateway, ctxId, claimId);
            const state = await this.options.contextRegistry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId);
            return { ...state, valid: false } as unknown as JsonValue;
        }
        if (await this.#hasPendingContextApproval(gateway, ctxId)) {
            await this.#releaseSource(gateway, ctxId, claimId);
            const state = await this.options.contextRegistry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId);
            return { ...state, valid: false } as unknown as JsonValue;
        }
        if (sourceKind === "wait") {
            if (claimedWait === undefined) return await this.#invalidClaim(ctxId, claimId);
            try {
                await assertWorkspaceWaitRecoveryAssociationAvailable(this.options, claimedWait, context);
            } catch {
                await gateway.consumeWait(this.options.instanceName, claimedWait.waitId).catch(() => undefined);
                return await this.#invalidClaim(ctxId, claimId);
            }
            return { ...validation.state, valid: true } as unknown as JsonValue;
        }
        if (await this.#hasBlockingAutomaticWait(gateway, ctxId)) {
            await this.#releaseSource(gateway, ctxId, claimId);
            return await this.#invalidClaim(ctxId, claimId);
        }
        if (sourceKind === "goal-resume" || sourceKind === "goal-retry" || sourceKind === "task-resume") {
            const sourceId = validation.state.sourceId;
            const valid = sourceId !== undefined && await this.#explicitSourceAvailable(gateway, ctxId, sourceKind, sourceId);
            if (!valid) {
                await this.#releaseSource(gateway, ctxId, claimId);
                return await this.#invalidClaim(ctxId, claimId);
            }
            return { ...validation.state, valid: true } as unknown as JsonValue;
        }
        const goalValidation = asRecord(await requireGoalGateway(this.options.gateway, this.options.instanceName).goalContinuation(
            this.options.instanceName,
            { action: "validate", available: true, claimId },
            ctxId,
        ));
        const valid = goalValidation?.valid === true;
        if (!valid) await this.options.contextRegistry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId).catch(() => undefined);
        const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
        return { ...state, valid } as unknown as JsonValue;
    }

    async #attempt(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
        claimId: string,
    ): Promise<JsonValue> {
        const validated = asRecord(await this.#validate(gateway, context, claimId));
        if (validated?.valid !== true) return { ...(validated ?? {}), attempted: false } as unknown as JsonValue;
        const ctxId = requireCtxId(context);
        const claimedWait = await this.#claimedWait(gateway, ctxId, claimId);
        const sourceKind = typeof validated.sourceKind === "string"
            ? validated.sourceKind
            : claimedWait === undefined ? "goal" : "wait";
        const state = await this.options.contextRegistry.markAutomaticReentryAttempted(
            ctxId,
            this.options.instanceName,
            claimId,
        );
        try {
            if (sourceKind === "wait") {
                if (claimedWait === undefined) throw new Error("Workspace wait re-entry claim is no longer active.");
                await requireWaitRecoveryGateway(this.options.gateway, this.options.instanceName)
                    .markWaitRecoveryAttempted(this.options.instanceName, claimedWait.waitId, claimId);
            } else if (sourceKind === "goal") {
                const attempted = asRecord(await requireGoalGateway(this.options.gateway, this.options.instanceName).goalContinuation(
                    this.options.instanceName,
                    { action: "attempt", available: true, claimId },
                    ctxId,
                ));
                if (attempted?.attempted !== true) throw new Error("Workspace Goal continuation attempt was rejected.");
            }
        } catch (error) {
            await this.#releaseSource(gateway, ctxId, claimId).catch(() => undefined);
            await this.options.contextRegistry.markAutomaticReentryRejected(
                ctxId,
                this.options.instanceName,
                claimId,
            ).catch(() => undefined);
            throw error;
        }
        return { ...state, attempted: true } as unknown as JsonValue;
    }

    async #report(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
        claimId: string,
        outcome: "accepted" | "rejected" | "uncertain",
    ): Promise<JsonValue> {
        const ctxId = requireCtxId(context);
        const reentry = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
        const claimedWait = await this.#claimedWait(gateway, ctxId, claimId);
        const sourceKind = reentry.claimId === claimId
            ? reentry.sourceKind
            : claimedWait === undefined ? undefined : "wait";
        if (sourceKind === "wait" && claimedWait !== undefined) {
            const recoveryGateway = requireWaitRecoveryGateway(this.options.gateway, this.options.instanceName);
            if (outcome === "accepted") {
                if (claimedWait.goalId !== undefined && this.options.gateway?.recordGoalReentry !== undefined) {
                    await this.options.gateway.recordGoalReentry(
                        this.options.instanceName,
                        ctxId,
                        claimedWait.recoveryGoalProgressEpoch ?? claimedWait.goalProgressEpoch,
                    ).catch(() => undefined);
                }
                await recoveryGateway.completeWaitRecovery(this.options.instanceName, claimedWait.waitId, claimId);
            } else {
                await gateway.consumeWait(this.options.instanceName, claimedWait.waitId).catch(() => undefined);
            }
        } else if (sourceKind === "goal") {
            const goalGateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
            if (outcome !== "uncertain") {
                await goalGateway.goalContinuation(
                    this.options.instanceName,
                    { action: "report", accepted: outcome === "accepted", claimId },
                    ctxId,
                ).catch((error: unknown) => {
                    if (outcome !== "accepted") throw error;
                });
            }
        } else if (
            (sourceKind === "goal-resume" || sourceKind === "goal-retry") &&
            outcome !== "rejected" && this.options.gateway?.recordGoalReentry !== undefined
        ) {
            const goal = await requireGoalGateway(this.options.gateway, this.options.instanceName)
                .readGoal(this.options.instanceName, ctxId);
            if (goal !== undefined && goal.goalId === reentry.sourceId) {
                await this.options.gateway.recordGoalReentry(
                    this.options.instanceName,
                    ctxId,
                    goal.progressEpoch,
                ).catch(() => undefined);
            }
        }

        const state = outcome === "rejected"
            ? await this.options.contextRegistry.markAutomaticReentryRejected(ctxId, this.options.instanceName, claimId)
            : await this.options.contextRegistry.markAutomaticReentryAccepted(ctxId, this.options.instanceName, claimId).catch(async () =>
                await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName)
            );
        return { ...state, outcome, reported: true } as unknown as JsonValue;
    }

    async #claimResolvedWaitDelivery(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
        claimId: string,
    ): Promise<WorkspaceReentryDelivery | undefined> {
        if (!isMcpWaitRecoveryGateway(this.options.gateway)) return undefined;
        const ctxId = requireCtxId(context);
        const candidates = await this.#resolvedAutomaticWaits(gateway, ctxId);
        for (const wait of candidates) {
            if (wait.recoveryMessageAttemptedAt !== undefined || wait.recoveryMessageSentAt !== undefined) {
                await gateway.consumeWait(this.options.instanceName, wait.waitId).catch(() => undefined);
                continue;
            }
            try {
                await assertWorkspaceWaitRecoveryAssociationAvailable(this.options, wait, context);
            } catch {
                await gateway.consumeWait(this.options.instanceName, wait.waitId).catch(() => undefined);
                continue;
            }
            let claimed: WaitRecord;
            try {
                claimed = await this.options.gateway.claimWaitRecovery(this.options.instanceName, wait.waitId, claimId);
                await this.options.contextRegistry.bindAutomaticReentrySource(
                    ctxId,
                    this.options.instanceName,
                    claimId,
                    "wait",
                    claimed.waitId,
                );
            } catch {
                await this.options.gateway.releaseWaitRecovery(this.options.instanceName, wait.waitId, claimId).catch(() => undefined);
                return undefined;
            }
            return waitReentryDelivery(claimed, await this.#workspaceSnapshot(gateway, ctxId));
        }
        return undefined;
    }

    async #releaseSource(gateway: McpInteractionGateway, ctxId: string, claimId: string): Promise<void> {
        const reentry = await this.options.contextRegistry.readAutomaticReentry(
            ctxId,
            this.options.instanceName,
        ).catch(() => undefined);
        if (reentry?.claimId !== claimId) return;
        if (reentry.sourceKind === "wait") {
            const claimedWait = await this.#claimedWait(gateway, ctxId, claimId);
            if (claimedWait !== undefined && isMcpWaitRecoveryGateway(this.options.gateway)) {
                await this.options.gateway.releaseWaitRecovery(
                    this.options.instanceName,
                    claimedWait.waitId,
                    claimId,
                ).catch(() => undefined);
            }
            return;
        }
        if (reentry.sourceKind === "goal" && isMcpGoalGateway(this.options.gateway)) {
            await this.options.gateway.goalContinuation(
                this.options.instanceName,
                { action: "release", claimId },
                ctxId,
            ).catch(() => undefined);
        }
    }

    async #settleAttemptedFromExecution(ctxId: string): Promise<void> {
        let state;
        try {
            state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
        } catch {
            return;
        }
        if (!state.attempted || state.claimId === undefined || state.sourceKind === undefined) return;
        const claimId = state.claimId;
        const sourceId = state.sourceId;
        let settled = true;
        try {
            if (state.sourceKind === "wait") {
                if (sourceId === undefined || this.options.gateway?.completeWaitRecovery === undefined) settled = false;
                else await this.options.gateway.completeWaitRecovery(this.options.instanceName, sourceId, claimId);
            } else if (state.sourceKind === "goal") {
                if (this.options.gateway?.goalContinuation === undefined) settled = false;
                else await this.options.gateway.goalContinuation(
                    this.options.instanceName,
                    { action: "report", accepted: true, claimId, ...(sourceId === undefined ? {} : { goalId: sourceId }) },
                    ctxId,
                );
            } else if (state.sourceKind === "goal-resume" || state.sourceKind === "goal-retry") {
                if (this.options.gateway?.recordGoalReentry !== undefined) {
                    const goal = await this.options.gateway.readGoal?.(this.options.instanceName, ctxId);
                    if (goal !== undefined && (sourceId === undefined || goal.goalId === sourceId)) {
                        await this.options.gateway.recordGoalReentry(this.options.instanceName, ctxId, goal.progressEpoch);
                    }
                }
            }
        } catch {
            settled = false;
        }
        if (!settled) return;
        await this.options.contextRegistry.markAutomaticReentryAccepted(
            ctxId,
            this.options.instanceName,
            claimId,
        ).catch(() => undefined);
    }

    async #explicitSourceAvailable(
        gateway: McpInteractionGateway,
        ctxId: string,
        intent: WorkspaceExplicitReentryKind,
        sourceId: string,
    ): Promise<boolean> {
        if (intent === "task-resume") {
            const todo = asRecord(await gateway.readTodo(this.options.instanceName, { taskId: sourceId }));
            if (todo?.taskId !== sourceId || !Array.isArray(todo.tasks)) return false;
            const task = todo.tasks.map(asRecord).find((entry) => entry?.taskId === sourceId && entry.ctxId === ctxId);
            return task?.status === "in_progress";
        }
        const goal = await requireGoalGateway(this.options.gateway, this.options.instanceName)
            .readGoal(this.options.instanceName, ctxId);
        return goal?.goalId === sourceId && goal.status === "active";
    }

    async #claimedWait(gateway: McpInteractionGateway, ctxId: string, claimId: string): Promise<WaitRecord | undefined> {
        return (await gateway.listWaits(this.options.instanceName)).find((wait) =>
            wait.createdByCtxId === ctxId && wait.status === "resolved" && wait.recoveryClaimId === claimId
        );
    }

    async #resolvedAutomaticWaits(gateway: McpInteractionGateway, ctxId: string): Promise<WaitRecord[]> {
        return (await gateway.listWaits(this.options.instanceName))
            .filter((wait) =>
                wait.createdByCtxId === ctxId && wait.status === "resolved" && wait.detachedAt !== undefined &&
                this.#waitEligibleForAutomaticNotification(wait)
            )
            .sort((left, right) =>
                (left.resolvedAt ?? left.updatedAt).localeCompare(right.resolvedAt ?? right.updatedAt) ||
                left.waitId.localeCompare(right.waitId)
            );
    }

    async #hasBlockingAutomaticWait(gateway: McpInteractionGateway, ctxId: string): Promise<boolean> {
        return (await gateway.listWaits(this.options.instanceName)).some((wait) =>
            wait.createdByCtxId === ctxId && wait.status !== "consumed" && wait.status !== "cancelled" &&
            this.#waitEligibleForAutomaticNotification(wait)
        );
    }

    #waitEligibleForAutomaticNotification(wait: WaitRecord): boolean {
        if (wait.recoveryDisabledAt !== undefined) return false;
        const explicitHumanResume = wait.kind === "question" || asRecord(wait.result)?.interrupted === true;
        return wait.automaticRecovery !== false || explicitHumanResume;
    }

    async #consumeResolvedWaitsDuringExecution(gateway: McpInteractionGateway, ctxId: string): Promise<void> {
        for (const wait of await this.#resolvedAutomaticWaits(gateway, ctxId)) {
            await gateway.consumeWait(this.options.instanceName, wait.waitId).catch(() => undefined);
        }
    }

    async #contextExecutionBusy(gateway: McpInteractionGateway, ctxId: string): Promise<boolean> {
        const state = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
        if (state.executionActive || state.attempted) return true;
        return await this.#hasActiveToolCall(ctxId, undefined, gateway);
    }

    async #hasActiveToolCall(
        ctxId: string,
        ownerCallId?: string,
        gateway: McpInstanceGateway | undefined = this.options.gateway,
    ): Promise<boolean> {
        if (gateway === undefined) return false;
        let instances = [this.options.instanceName];
        try {
            instances = await this.#contextInstances(ctxId);
        } catch {
            // A detached wait can outlive Context metadata. The owning instance remains the safe fallback.
        }
        for (const instance of instances) {
            try {
                if (gateway.hasActiveToolCalls?.(instance, ctxId, ownerCallId) === true) return true;
                if (gateway.readToolCalls !== undefined) {
                    const calls = await gateway.readToolCalls(instance, ctxId, 64);
                    if (calls.some((call) =>
                        call.status === "queued" || call.status === "pendingApproval" || call.status === "running"
                    )) return true;
                }
            } catch {
                // A disconnected auxiliary instance does not make the owning Context busy by itself.
            }
        }
        return false;
    }

    async #hasPendingContextApproval(gateway: McpInteractionGateway, ctxId: string): Promise<boolean> {
        for (const instance of await this.#contextInstances(ctxId)) {
            try {
                const approvals = gateway.listPendingApprovals !== undefined
                    ? await gateway.listPendingApprovals(instance, ctxId)
                    : await gateway.listApprovals(instance);
                if (approvals.some((approval) => approval.ctxId === ctxId && approval.status === "pending")) return true;
            } catch {
                // A disconnected auxiliary instance cannot contribute an actionable local approval.
            }
        }
        return false;
    }

    async #workspaceSnapshot(gateway: McpInteractionGateway, ctxId: string): Promise<JsonValue> {
        const record = await this.options.contextRegistry.validateForInstance(ctxId, this.options.instanceName);
        const reentry = await this.options.contextRegistry.readAutomaticReentry(ctxId, this.options.instanceName);
        return await readWorkspaceSnapshot(gateway, this.options.instanceName, ctxId, {
            instances: record.environments.map((environment) => environment.instance),
            reentry: reentry as unknown as JsonValue,
        });
    }

    async #contextInstances(ctxId: string): Promise<string[]> {
        const record = await this.options.contextRegistry.validateForInstance(ctxId, this.options.instanceName);
        return [...new Set([this.options.instanceName, ...record.environments.map((environment) => environment.instance)])];
    }

    async #invalidClaim(ctxId: string, claimId: string): Promise<JsonValue> {
        const state = await this.options.contextRegistry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId);
        return { ...state, valid: false } as unknown as JsonValue;
    }

    async #releaseUnclaimedContext(ctxId: string, claimId: string): Promise<JsonValue> {
        const state = await this.options.contextRegistry.releaseAutomaticReentry(ctxId, this.options.instanceName, claimId);
        return { ...state, claimed: false, claimId } as unknown as JsonValue;
    }
}

function readReentryControl(input: JsonValue): {
    action: "get" | "yield" | "resume" | "claim" | "validate" | "attempt" | "report" | "release";
    claimId?: string;
    intent?: "automatic" | WorkspaceExplicitReentryKind;
    outcome?: "accepted" | "rejected" | "uncertain";
    reason?: string;
    sourceId?: string;
} {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_reentry requires an object input.");
    const action = record.action;
    if (
        action !== "get" && action !== "yield" && action !== "resume" && action !== "claim" && action !== "validate" &&
        action !== "attempt" && action !== "report" && action !== "release"
    ) {
        throw new Error("workspace_reentry action must be get, yield, resume, claim, validate, attempt, report, or release.");
    }
    const intent = record.intent;
    if (
        intent !== undefined && intent !== "automatic" && intent !== "goal-resume" &&
        intent !== "goal-retry" && intent !== "task-resume"
    ) {
        throw new Error("workspace_reentry intent must be automatic, goal-resume, goal-retry, or task-resume.");
    }
    const outcome = record.outcome;
    if (outcome !== undefined && outcome !== "accepted" && outcome !== "rejected" && outcome !== "uncertain") {
        throw new Error("workspace_reentry outcome must be accepted, rejected, or uncertain.");
    }
    return {
        action,
        ...(typeof record.claimId === "string" ? { claimId: record.claimId } : {}),
        ...(intent === undefined ? {} : { intent }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        ...(typeof record.sourceId === "string" ? { sourceId: record.sourceId } : {}),
    };
}

function requireInteractionGateway(gateway: McpInstanceGateway | undefined, instanceName: string): McpInteractionGateway {
    if (isMcpInteractionGateway(gateway)) return gateway;
    throw new Error(`Workspace interaction backend is unavailable for ${instanceName}.`);
}

function requireGoalGateway(gateway: McpInstanceGateway | undefined, instanceName: string) {
    if (isMcpGoalGateway(gateway)) return gateway;
    throw new Error(`Workspace Goal backend is unavailable for ${instanceName}.`);
}

function requireWaitRecoveryGateway(gateway: McpInstanceGateway | undefined, instanceName: string) {
    if (isMcpWaitRecoveryGateway(gateway)) return gateway;
    throw new Error(`Workspace wait recovery backend is unavailable for ${instanceName}.`);
}

function requireCtxId(context: ToolCallContext): string {
    if (typeof context.ctxId !== "string" || context.ctxId.length === 0) {
        throw new Error("Workspace interaction requires ctxId.");
    }
    return context.ctxId;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, JsonValue>
        : undefined;
}
