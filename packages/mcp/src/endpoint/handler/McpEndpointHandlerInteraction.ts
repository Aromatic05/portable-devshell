import { randomUUID } from "node:crypto";

import type {
    GoalContinuationInput,
    GoalManageInput,
    GoalSnapshot,
    JsonValue,
    TodoTaskControlAction,
    ToolCallContext,
    WaitRecord
} from "@portable-devshell/shared";

import {
    isMcpGoalGateway,
    isMcpInteractionGateway,
    isMcpWaitRecoveryGateway,
    isMcpWaitTrackingGateway,
    isMcpWorkspaceGateway,
    type McpInstanceGateway,
    type McpInteractionGateway
} from "../../instance/McpInstanceGateway.js";
import type { McpContextRegistry } from "../../context/McpContextRegistry.js";
import type { McpToolCatalogInteractionName } from "../../tool/catalog/McpToolCatalogInteraction.js";
import { readWorkspaceSnapshot, workspaceEventBelongsTo } from "../../workspace/McpWorkspaceSnapshot.js";
import { WorkspaceAppLeaseStore } from "../../workspace/WorkspaceAppLeaseStore.js";
import { WorkspaceAppPresenceStore } from "../../workspace/WorkspaceAppPresenceStore.js";
import { throwIfMcpEndpointAborted, waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { McpNativeToolResult, type McpEndpointResult } from "../McpEndpointResult.js";

export class McpEndpointHandlerInteraction {
    readonly #appLeases: WorkspaceAppLeaseStore;
    readonly #appPresence: WorkspaceAppPresenceStore;

    constructor(private readonly options: {
        contextRegistry?: McpContextRegistry;
        gateway?: McpInstanceGateway;
        instanceName: string;
        now?: () => number;
        watchHeartbeatMs?: number;
        watchPollMs?: number;
        workspaceActivationGraceMs?: number;
        workspaceLivenessMs?: number;
        workspaceAppLeases?: WorkspaceAppLeaseStore;
        workspaceAppPresence?: WorkspaceAppPresenceStore;
        workspaceLiveBaseUrl?: string;
    }) {
        this.#appLeases = options.workspaceAppLeases ?? new WorkspaceAppLeaseStore();
        this.#appPresence = options.workspaceAppPresence ?? new WorkspaceAppPresenceStore({ now: options.now });
    }

    async call(
        toolName: McpToolCatalogInteractionName,
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        const gateway = requireInteractionGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "workspace_ask":
                return await this.#askQuestion(gateway, input, context, callId, signal);
            case "workspace_goal":
                return await this.#manageGoal(input, context);
            case "workspace_open":
                return await this.#openWorkspace(context);
            case "workspace_reconnect":
                return await this.#reconnectWorkspace(gateway, input, context);
            case "workspace_snapshot":
                return await this.#readWorkspace(gateway, input, context);
            case "workspace_watch":
                return await this.#watchWorkspace(gateway, input, context, signal);
            case "workspace_question_answer":
                await this.#assertAppToken(input, context);
                return await this.#answerQuestion(gateway, input, context);
            case "workspace_wait_interrupt":
                await this.#assertAppToken(input, context);
                return await this.#interruptWait(gateway, input, context);
            case "workspace_task_control":
                await this.#assertAppToken(input, context);
                return await this.#controlTask(gateway, input, context);
            case "workspace_wait_recover":
                await this.#assertAppToken(input, context);
                return await this.#recoverWait(gateway, input, context);
            case "workspace_goal_continue":
                await this.#assertAppToken(input, context);
                return await this.#continueGoal(gateway, input, context);
            case "workspace_reentry_control":
                await this.#assertAppToken(input, context);
                return await this.#controlReentry(input, context);
            case "workspace_goal_pause":
                await this.#assertAppToken(input, context);
                return await this.#pauseGoal(input, context);
            case "workspace_goal_resume":
                await this.#assertAppToken(input, context);
                return await this.#resumeGoal(input, context);
            case "workspace_goal_stop":
                await this.#assertAppToken(input, context);
                return await this.#stopGoal(input, context);
            case "workspace_approval_decide":
                await this.#assertAppToken(input, context);
                return await this.#decideApproval(gateway, input, context);
        }
    }

    async bootstrapWorkspace(
        ctxId: string,
        structuredContent: JsonValue,
        content: McpNativeToolResult["content"] = [],
    ): Promise<McpNativeToolResult> {
        const token = await this.#appLeases.issue(this.options.instanceName, ctxId);
        this.#appPresence.open(this.options.instanceName, ctxId);
        return this.#workspaceResult(
            ctxId,
            token,
            structuredContent,
            content,
            false,
        );
    }

    async #askQuestion(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const request = readQuestion(input);
        const ctxId = requireCtxId(context);
        await this.#requireActiveWorkspace(
            ctxId,
            "workspace_ask requires an active Live Workspace for this ctxId. environ_info normally bootstraps the Live Workspace; call workspace_open only to re-present or restore it when the App is no longer active.",
        );
        const goalGateway = isMcpGoalGateway(this.options.gateway) ? this.options.gateway : undefined;
        const goal = await goalGateway?.readGoal(this.options.instanceName, ctxId);
        const attachedGoal = goal !== undefined && (goal.status === "active" || goal.status === "blocked") ? goal : undefined;
        const taskAssociation = attachedGoal === undefined
            ? await currentTodoAssociation(gateway, this.options.instanceName, ctxId)
            : { kind: "none" as const };
        const goalStep = attachedGoal?.steps.find((step) => step.status === "active");
        const questionId = `question-${randomUUID()}`;
        const wait = await gateway.createWait(this.options.instanceName, {
            automaticRecovery: taskAssociation.kind !== "ambiguous",
            createdByCtxId: ctxId,
            ...(attachedGoal === undefined ? {} : { goalId: attachedGoal.goalId, goalProgressAt: attachedGoal.lastProgressAt, goalRevision: attachedGoal.revision }),
            ...(goalStep === undefined ? {} : { goalStepId: goalStep.id }),
            kind: "question",
            ownerCallId: callId,
            payload: {
                allowText: request.allowText,
                choices: request.choices,
                question: request.question,
            },
            targetId: questionId,
            ...(taskAssociation.kind !== "one" ? {} : {
                taskId: taskAssociation.taskId,
                taskRevision: taskAssociation.revision,
                todoItemId: taskAssociation.todoItemId,
            }),
            ...(context.workspace === undefined ? {} : { workspace: context.workspace }),
        });

        let resolved: WaitRecord;
        try {
            resolved = await waitForMcpEndpointAbortable(
                gateway.waitForWait(this.options.instanceName, wait.waitId),
                signal,
            );
        } catch (error) {
            if (signal?.aborted === true) {
                await gateway.detachWait(this.options.instanceName, wait.waitId).catch(() => undefined);
            }
            throw error;
        }

        if (signal?.aborted === true) {
            await gateway.detachWait(this.options.instanceName, wait.waitId).catch(() => undefined);
            throwIfMcpEndpointAborted(signal);
        }
        const answer = readAnswer(resolved.result);
        try {
            await gateway.touchGoal?.(this.options.instanceName, ctxId);
            throwIfMcpEndpointAborted(signal);
            await gateway.consumeWait(this.options.instanceName, wait.waitId);
        } catch (error) {
            const current = (await gateway.listWaits(this.options.instanceName))
                .find((entry) => entry.waitId === wait.waitId);
            if (current?.status === "resolved" && current.detachedAt === undefined) {
                await gateway.detachWait(this.options.instanceName, wait.waitId).catch(() => undefined);
            }
            throw error;
        }
        return { answer, questionId };
    }

    async #openWorkspace(context: ToolCallContext): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        return await this.bootstrapWorkspace(
            ctxId,
            {
                ctxId,
                instance: this.options.instanceName,
            },
            [{ type: "text", text: "portable-devshell Workspace opened." }],
        );
    }

    async #manageGoal(input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
        const request = readGoalManageInput(input);
        const ctxId = requireCtxId(context);
        request.workspace = context.workspace;
        if (request.action === "start") {
            this.#requirePresentedWorkspace(
                ctxId,
                "workspace_goal start requires an initialized Workspace for this ctxId. Call environ_info with workspace to initialize it before starting a Goal.",
            );
        }
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            request,
            ctxId,
        );
        if (goal !== undefined) await this.#reconcileGoalWaits(ctxId, goal);
        if (request.action === "start") {
            await this.options.contextRegistry?.resumeAutomaticReentry(ctxId, this.options.instanceName);
        } else if (request.action !== "get") {
            await this.options.contextRegistry?.observeAutomaticReentryActivity(
                ctxId,
                this.options.instanceName,
                request.action === "block" ? "wait" : request.action === "update" && request.objective === undefined && request.steps === undefined && request.stepId === undefined
                    ? "observation"
                    : "mutation",
            );
        }
        return { goal: goal ?? null } as unknown as JsonValue;
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
        return await goalGateway.goalContinuation(
            this.options.instanceName,
            request,
            ctxId,
        );
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

    async #pauseGoal(input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
        const fence = readGoalFence(input, "workspace_goal_pause");
        const ctxId = requireCtxId(context);
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            { action: "pause", expectedGoalId: fence.goalId, expectedRevision: fence.revision, userControl: true, workspace: context.workspace },
            ctxId,
        );
        await this.options.contextRegistry?.suppressAutomaticReentry(
            ctxId,
            this.options.instanceName,
            "Workspace Goal paused by user",
            "paused",
        );
        return { goal: goal ?? null } as unknown as JsonValue;
    }

    async #stopGoal(input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
        const fence = readGoalFence(input, "workspace_goal_stop");
        const ctxId = requireCtxId(context);
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            { action: "stop", expectedGoalId: fence.goalId, expectedRevision: fence.revision, workspace: context.workspace },
            ctxId,
        );
        if (goal !== undefined) await this.#reconcileGoalWaits(ctxId, goal);
        await this.options.contextRegistry?.suppressAutomaticReentry(ctxId, this.options.instanceName, "Workspace Goal stopped by user");
        return { goal: goal ?? null } as unknown as JsonValue;
    }

    async #resumeGoal(input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
        const fence = readGoalFence(input, "workspace_goal_resume");
        const ctxId = requireCtxId(context);
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            { action: "resume", expectedGoalId: fence.goalId, expectedRevision: fence.revision, userControl: true, workspace: context.workspace },
            ctxId,
        );
        if (goal !== undefined) await this.#reconcileGoalWaits(ctxId, goal);
        await this.options.contextRegistry?.resumeAutomaticReentry(ctxId, this.options.instanceName);
        return { goal: goal ?? null } as unknown as JsonValue;
    }

    async #readWorkspace(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        const token = await this.#assertAppToken(input, context);
        return this.#workspaceResult(
            ctxId,
            token,
            await this.#workspaceSnapshot(gateway, ctxId),
        );
    }

    async #reconnectWorkspace(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        const token = await this.#assertAppToken(input, context);
        return this.#workspaceResult(
            ctxId,
            token,
            await this.#workspaceSnapshot(gateway, ctxId),
        );
    }

    async #watchWorkspace(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<McpNativeToolResult> {
        if (!isMcpWorkspaceGateway(gateway)) {
            throw new Error(`Workspace live events are unavailable for ${this.options.instanceName}.`);
        }
        const ctxId = requireCtxId(context);
        const token = await this.#assertAppToken(input, context);
        const startedAt = this.options.now?.() ?? Date.now();
        const instances = await this.#contextInstances(ctxId);
        const configuredHeartbeatMs = this.options.watchHeartbeatMs ?? 20_000;
        const heartbeatMs = instances.length > 1
            ? Math.min(configuredHeartbeatMs, 1_000)
            : configuredHeartbeatMs;
        const pollMs = this.options.watchPollMs ?? 250;
        let cursor = readWorkspaceCursor(input);
        this.#beginWorkspaceWatch(ctxId);
        try {
            while (true) {
                const batch = await gateway.readWorkspaceEvents(this.options.instanceName, cursor + 1);
                const changed = batch.gap || batch.lastSeq < cursor || batch.events.some((event) => workspaceEventBelongsTo(event, ctxId));
                cursor = batch.lastSeq;
                if (changed) {
                    return this.#workspaceResult(ctxId, token, {
                        changed: true,
                        cursor,
                        snapshot: await this.#workspaceSnapshot(gateway, ctxId),
                    });
                }
                if ((this.options.now?.() ?? Date.now()) - startedAt >= heartbeatMs) {
                    return this.#workspaceResult(ctxId, token, {
                        changed: false,
                        cursor,
                        snapshot: await this.#workspaceSnapshot(gateway, ctxId),
                    });
                }
                await waitForMcpEndpointAbortable(delay(pollMs), signal);
            }
        } finally {
            this.#endWorkspaceWatch(ctxId);
        }
    }

    async #workspaceSnapshot(gateway: McpInteractionGateway, ctxId: string): Promise<JsonValue> {
        const registry = this.options.contextRegistry;
        if (registry === undefined) return await readWorkspaceSnapshot(gateway, this.options.instanceName, ctxId);
        const record = await registry.validateForInstance(ctxId, this.options.instanceName);
        const reentry = await registry.readAutomaticReentry(ctxId, this.options.instanceName);
        return await readWorkspaceSnapshot(gateway, this.options.instanceName, ctxId, {
            instances: record.environments.map((environment) => environment.instance),
            reentry: reentry as unknown as JsonValue,
        });
    }

    async #contextInstances(ctxId: string): Promise<string[]> {
        const registry = this.options.contextRegistry;
        if (registry === undefined) return [this.options.instanceName];
        const record = await registry.validateForInstance(ctxId, this.options.instanceName);
        return [...new Set([this.options.instanceName, ...record.environments.map((environment) => environment.instance)])];
    }

    async #reconcileGoalWaits(ctxId: string, goal: GoalSnapshot): Promise<void> {
        const gateway = this.options.gateway;
        if (!isMcpWaitRecoveryGateway(gateway)) return;
        const currentStepId = goal.steps.find((step) => step.status === "active")?.id;
        const terminal = goal.status === "completed" || goal.status === "stopped";
        const waits = await gateway.listWaits(this.options.instanceName);
        for (const wait of waits) {
            if (wait.createdByCtxId !== ctxId || wait.goalId !== goal.goalId) continue;
            if (wait.status === "consumed" || wait.status === "cancelled" || wait.recoveryDisabledAt !== undefined) continue;
            const staleStep = wait.goalStepId !== undefined && wait.goalStepId !== currentStepId;
            const staleProgress = wait.goalStepId === undefined && wait.goalProgressAt !== undefined &&
                wait.goalProgressAt !== goal.lastProgressAt;
            const staleLegacyRevision = wait.goalStepId === undefined && wait.goalProgressAt === undefined &&
                wait.goalRevision !== undefined && wait.goalRevision !== goal.revision;
            if (!terminal && !staleStep && !staleProgress && !staleLegacyRevision) continue;
            if (wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached") && gateway.cancelWait !== undefined) {
                await gateway.cancelWait(this.options.instanceName, wait.waitId).catch(() => undefined);
                continue;
            }
            await gateway.disableWaitRecovery(this.options.instanceName, wait.waitId).catch(() => undefined);
        }
    }

    async #disableTaskWaits(ctxId: string, taskId: string): Promise<void> {
        const gateway = this.options.gateway;
        if (!isMcpWaitRecoveryGateway(gateway)) return;
        const waits = await gateway.listWaits(this.options.instanceName);
        for (const wait of waits) {
            if (wait.createdByCtxId !== ctxId || wait.taskId !== taskId) continue;
            if (wait.status === "consumed" || wait.status === "cancelled" || wait.recoveryDisabledAt !== undefined) continue;
            if (wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached") && gateway.cancelWait !== undefined) {
                await gateway.cancelWait(this.options.instanceName, wait.waitId).catch(() => undefined);
                continue;
            }
            await gateway.disableWaitRecovery(this.options.instanceName, wait.waitId).catch(() => undefined);
        }
    }

    #workspaceResult(
        ctxId: string,
        token: string,
        structuredContent: JsonValue,
        content: McpNativeToolResult["content"] = [],
        markAppSeen = true,
    ): McpNativeToolResult {
        if (!this.#appPresence.has(this.options.instanceName, ctxId)) {
            throw new Error("Workspace App authorization is unavailable for the current Context.");
        }
        if (markAppSeen) this.#appPresence.touch(this.options.instanceName, ctxId);
        return new McpNativeToolResult({
            _meta: {
                "portable-devshell/workspace": {
                    token,
                    ...(this.options.workspaceLiveBaseUrl === undefined
                        ? {}
                        : { liveBaseUrl: this.options.workspaceLiveBaseUrl }),
                },
            },
            content,
            structuredContent,
        });
    }

    #workspaceIsActive(ctxId: string): boolean {
        return this.#appPresence.isActive(
            this.options.instanceName,
            ctxId,
            this.options.workspaceLivenessMs ?? 60_000,
        );
    }

    #beginWorkspaceWatch(ctxId: string): void {
        this.#appPresence.beginWatch(this.options.instanceName, ctxId);
    }

    #endWorkspaceWatch(ctxId: string): void {
        this.#appPresence.endWatch(this.options.instanceName, ctxId);
    }

    async #requireActiveWorkspace(ctxId: string, message: string): Promise<void> {
        if (this.#workspaceIsActive(ctxId)) return;
        if (!this.#appPresence.has(this.options.instanceName, ctxId)) throw new Error(message);
        const graceMs = this.options.workspaceActivationGraceMs ?? 5_000;
        if (!await this.#appPresence.waitUntilActive(
            this.options.instanceName,
            ctxId,
            this.options.workspaceLivenessMs ?? 60_000,
            graceMs,
        )) {
            throw new Error(
                "Workspace is already initialized for this Context, but the Live Workspace App is not active yet. This can happen during the transient startup or handoff race between Workspace presentation and the App snapshot/watch handshake. The current ctxId and workspace remain valid; do not call environ_info again, create a new Context, or switch ctxId. Retry the Workspace-dependent operation once the App becomes active. Call workspace_open with the same Context only if the Workspace App is no longer presented.",
            );
        }
    }

    #requirePresentedWorkspace(ctxId: string, message: string): void {
        if (this.#appPresence.has(this.options.instanceName, ctxId)) return;
        throw new Error(message);
    }

    async #answerQuestion(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const { answer, waitId } = readQuestionAnswer(input);
        const wait = (await gateway.listWaits(this.options.instanceName)).find((record) => record.waitId === waitId);
        if (wait === undefined || wait.kind !== "question" || wait.createdByCtxId !== requireCtxId(context)) {
            throw new Error(`Question wait ${waitId} was not found for the current Context.`);
        }
        validateQuestionAnswer(wait, answer);
        const resolved = await gateway.resolveWait(this.options.instanceName, waitId, { answer });
        await this.options.contextRegistry?.resumeAutomaticReentry(requireCtxId(context), this.options.instanceName);
        return {
            answer,
            detached: resolved.detachedAt !== undefined,
            ...(resolved.goalId === undefined ? {} : { goalId: resolved.goalId }),
            questionId: resolved.targetId,
            ...(resolved.taskId === undefined ? {} : { taskId: resolved.taskId }),
            waitId: resolved.waitId,
        };
    }

    async #interruptWait(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        if (!isMcpWaitTrackingGateway(gateway)) {
            throw new Error(`Workspace wait interruption is unavailable for ${this.options.instanceName}.`);
        }
        const waitId = readWaitId(input, "workspace_wait_interrupt");
        const wait = (await gateway.listWaits(this.options.instanceName)).find((entry) => entry.waitId === waitId);
        if (
            wait === undefined || wait.createdByCtxId !== requireCtxId(context) ||
            wait.kind !== "tmux" || (wait.status !== "waiting" && wait.status !== "detached")
        ) {
            throw new Error(`Interruptible tmux wait ${waitId} was not found for the current Context.`);
        }
        const interrupted = {
            interrupted: true,
            task: { id: wait.targetId, status: "running" },
        } as const;
        const resolved = await gateway.resolveWait(this.options.instanceName, waitId, interrupted);
        await this.options.contextRegistry?.resumeAutomaticReentry(requireCtxId(context), this.options.instanceName);
        return {
            detached: resolved.detachedAt !== undefined,
            ...(resolved.goalId === undefined ? {} : { goalId: resolved.goalId }),
            interrupted: true,
            status: resolved.status,
            ...(resolved.taskId === undefined ? {} : { taskId: resolved.taskId }),
            tmuxTaskId: resolved.targetId,
            waitId: resolved.waitId,
        };
    }

    async #controlTask(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        if (gateway.controlTodo === undefined) {
            throw new Error(`Workspace task control is unavailable for ${this.options.instanceName}.`);
        }
        const { action, revision, taskId } = readTaskControl(input);
        const ctxId = requireCtxId(context);
        const task = asRecord(await gateway.readTodo(this.options.instanceName, { taskId }));
        if (task?.taskId !== taskId || !taskBelongsToContext(task, taskId, ctxId)) {
            throw new Error(`Todo task ${taskId} is not attached to the current Context.`);
        }
        const controlled = await gateway.controlTodo(this.options.instanceName, taskId, action, ctxId, revision);
        if (action === "cancel") {
            await this.#disableTaskWaits(ctxId, taskId);
            await this.options.contextRegistry?.suppressAutomaticReentry(ctxId, this.options.instanceName, "Workspace task cancelled by user");
        } else if (action === "pause") {
            await this.options.contextRegistry?.suppressAutomaticReentry(ctxId, this.options.instanceName, "Workspace task paused by user", "paused");
        } else {
            await this.options.contextRegistry?.resumeAutomaticReentry(ctxId, this.options.instanceName);
        }
        return controlled;
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
        const waitId = recovery.waitId;
        const wait = (await gateway.listWaits(this.options.instanceName)).find((entry) => entry.waitId === waitId);
        if (
            wait === undefined || wait.createdByCtxId !== requireCtxId(context) ||
            (wait.kind !== "tmux" && wait.kind !== "question") ||
            wait.detachedAt === undefined || wait.status !== "resolved"
        ) {
            throw new Error(`Recoverable detached wait ${waitId} was not found for the current Context.`);
        }
        if (recovery.action === "dismiss") {
            const dismissed = await gateway.dismissWaitRecovery(
                this.options.instanceName,
                waitId,
                recovery.recoveryMessageId,
            );
            return {
                dismissed: true,
                kind: dismissed.kind,
                targetId: dismissed.targetId,
                waitId: dismissed.waitId,
            };
        }
        if (recovery.action === "attempt") {
            await this.#assertWaitRecoveryAssociationAvailable(gateway, wait, context);
            const attempted = await gateway.markWaitRecoveryAttempted(this.options.instanceName, waitId, recovery.claimId);
            return {
                attempted: true,
                ...(attempted.recoveryMessageAttemptedAt === undefined ? {} : { recoveryMessageAttemptedAt: attempted.recoveryMessageAttemptedAt }),
                ...(attempted.recoveryMessageId === undefined ? {} : { recoveryMessageId: attempted.recoveryMessageId }),
                waitId: attempted.waitId,
            };
        }
        if (recovery.action === "sent") {
            const sent = await gateway.markWaitRecoverySent(this.options.instanceName, waitId, recovery.claimId);
            if (sent.goalId !== undefined && this.options.gateway?.recordGoalReentry !== undefined) {
                await this.options.gateway.recordGoalReentry(this.options.instanceName, requireCtxId(context));
            }
            return {
                ...(sent.recoveryMessageAttemptedAt === undefined ? {} : { recoveryMessageAttemptedAt: sent.recoveryMessageAttemptedAt }),
                ...(sent.recoveryMessageId === undefined ? {} : { recoveryMessageId: sent.recoveryMessageId }),
                ...(sent.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: sent.recoveryMessageSentAt }),
                ...(sent.recoveryRetryAfter === undefined ? {} : { recoveryRetryAfter: sent.recoveryRetryAfter }),
                ...(sent.recoveryRetryCount === undefined ? {} : { recoveryRetryCount: sent.recoveryRetryCount }),
                sent: true,
                waitId: sent.waitId,
            };
        }
        if (recovery.action === "release") {
            await gateway.releaseWaitRecovery(this.options.instanceName, waitId, recovery.claimId);
            return { released: true, waitId };
        }
        if (recovery.action === "reject") {
            await gateway.rejectWaitRecovery(this.options.instanceName, waitId, recovery.claimId);
            return { rejected: true, waitId };
        }
        if (recovery.action === "complete") {
            const consumed = await gateway.completeWaitRecovery(this.options.instanceName, waitId, recovery.claimId);
            return {
                completed: true,
                kind: consumed.kind,
                targetId: consumed.targetId,
                waitId: consumed.waitId,
            };
        }
        await this.#assertWaitRecoveryAssociationAvailable(gateway, wait, context);
        const claimId = `recovery-${randomUUID()}`;
        const claimed = await gateway.claimWaitRecovery(this.options.instanceName, waitId, claimId);
        return {
            claimId,
            ...(claimed.goalId === undefined ? {} : { goalId: claimed.goalId }),
            kind: claimed.kind,
            ...(claimed.result === undefined ? {} : { result: claimed.result }),
            ...(claimed.recoveryMessageAttemptedAt === undefined ? {} : { recoveryMessageAttemptedAt: claimed.recoveryMessageAttemptedAt }),
            ...(claimed.recoveryMessageId === undefined ? {} : { recoveryMessageId: claimed.recoveryMessageId }),
            ...(claimed.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: claimed.recoveryMessageSentAt }),
            ...(claimed.recoveryRetryAfter === undefined ? {} : { recoveryRetryAfter: claimed.recoveryRetryAfter }),
            ...(claimed.recoveryRetryCount === undefined ? {} : { recoveryRetryCount: claimed.recoveryRetryCount }),
            ...(claimed.taskId === undefined ? {} : { taskId: claimed.taskId }),
            targetId: claimed.targetId,
            waitId: claimed.waitId,
        };
    }

    async #assertWaitRecoveryAssociationAvailable(
        gateway: McpInteractionGateway,
        wait: WaitRecord,
        context: ToolCallContext,
    ): Promise<void> {
        const ctxId = requireCtxId(context);
        const explicitHumanResume = wait.kind === "question" || asRecord(wait.result)?.interrupted === true;
        if (wait.recoveryDisabledAt !== undefined || (wait.automaticRecovery === false && !explicitHumanResume)) {
            throw new Error(`Wait ${wait.waitId} is not available for automatic recovery.`);
        }
        if (wait.workspace !== undefined && context.workspace !== undefined && wait.workspace !== context.workspace) {
            throw new Error(`Wait ${wait.waitId} belongs to another workspace.`);
        }
        if (wait.goalId !== undefined) {
            const goalGateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
            const goal = await goalGateway.readGoal(this.options.instanceName, ctxId);
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
        } else if (wait.taskId !== undefined) {
            const todo = asRecord(await gateway.readTodo(this.options.instanceName, { taskId: wait.taskId }));
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
    }

    async #decideApproval(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const { approvalId, decision } = readApprovalDecision(input);
        const ctxId = requireCtxId(context);
        const instances = await this.#contextInstances(ctxId);
        let approval: Awaited<ReturnType<McpInteractionGateway["listApprovals"]>>[number] | undefined;
        let approvalInstance: string | undefined;
        for (const instance of instances) {
            const candidate = (await gateway.listApprovals(instance).catch(() => [])).find((entry) => entry.approvalId === approvalId);
            if (candidate !== undefined) {
                approval = candidate;
                approvalInstance = instance;
                break;
            }
        }
        if (approval === undefined || approvalInstance === undefined || approval.ctxId !== ctxId || approval.status !== "pending") {
            throw new Error(`Pending approval ${approvalId} was not found for the current Context.`);
        }
        const decided = await gateway.decideApproval(approvalInstance, approvalId, decision);
        const { ctxId: _ctxId, ...visible } = decided;
        return visible as unknown as JsonValue;
    }

    async #assertAppToken(input: JsonValue, context: ToolCallContext): Promise<string> {
        const ctxId = requireCtxId(context);
        const record = asRecord(input);
        const token = record === undefined ? undefined : record.token;
        if (
            typeof token !== "string" || token.length === 0 ||
            !await this.#appLeases.verify(this.options.instanceName, ctxId, token)
        ) {
            throw new Error("Workspace App authorization is invalid for the current Context.");
        }
        this.#appPresence.touch(this.options.instanceName, ctxId);
        return token;
    }
}

function requireInteractionGateway(
    gateway: McpInstanceGateway | undefined,
    instanceName: string,
): McpInteractionGateway {
    if (isMcpInteractionGateway(gateway)) return gateway;
    throw new Error(`Workspace interaction backend is unavailable for ${instanceName}.`);
}

function requireGoalGateway(gateway: McpInstanceGateway | undefined, instanceName: string) {
    if (isMcpGoalGateway(gateway)) return gateway;
    throw new Error(`Workspace Goal backend is unavailable for ${instanceName}.`);
}

function readGoalManageInput(input: JsonValue): GoalManageInput {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_goal requires an object input.");
    const action = record.action;
    if (
        action !== "start" && action !== "get" && action !== "update" && action !== "block" &&
        action !== "resume" && action !== "finish" && action !== "stop"
    ) {
        throw new Error("workspace_goal action must be start, get, update, block, resume, finish, or stop.");
    }
    return {
        action,
        ...(typeof record.note === "string" ? { note: record.note } : {}),
        ...(typeof record.objective === "string" ? { objective: record.objective } : {}),
        ...(typeof record.status === "string" ? { status: record.status as GoalManageInput["status"] } : {}),
        ...(typeof record.stepId === "string" ? { stepId: record.stepId } : {}),
        ...(Array.isArray(record.steps) ? { steps: record.steps as unknown as GoalManageInput["steps"] } : {}),
        ...(typeof record.text === "string" ? { text: record.text } : {}),
    };
}

function readGoalContinuationInput(input: JsonValue): GoalContinuationInput {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_goal_continue requires an object input.");
    const action = record.action;
    if (action !== "claim" && action !== "validate" && action !== "attempt" && action !== "report" && action !== "reset") {
        throw new Error("workspace_goal_continue action must be claim, validate, attempt, report, or reset.");
    }
    return {
        action,
        ...(typeof record.accepted === "boolean" ? { accepted: record.accepted } : {}),
        ...(typeof record.available === "boolean" ? { available: record.available } : {}),
        ...(typeof record.claimId === "string" ? { claimId: record.claimId } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
    };
}

function readReentryControl(input: JsonValue): {
    action: "get" | "yield" | "resume" | "claim" | "validate" | "release";
    claimId?: string;
    reason?: string;
} {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_reentry_control requires an object input.");
    const action = record.action;
    if (
        action !== "get" && action !== "yield" && action !== "resume" &&
        action !== "claim" && action !== "validate" && action !== "release"
    ) {
        throw new Error("workspace_reentry_control action is invalid.");
    }
    return {
        action,
        ...(typeof record.claimId === "string" ? { claimId: record.claimId } : {}),
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    };
}

function readQuestion(input: JsonValue): {
    allowText: boolean;
    choices: string[];
    question: string;
} {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_ask requires an object input.");
    const question = text(record.question, "question");
    const choices = record.choices === undefined ? [] : stringArray(record.choices, "choices");
    const allowText = record.allowText === undefined ? true : record.allowText;
    if (typeof allowText !== "boolean") throw new Error("allowText must be a boolean.");
    if (!allowText && choices.length === 0) throw new Error("workspace_ask requires choices when allowText is false.");
    return { allowText, choices, question };
}

function readQuestionAnswer(input: JsonValue): { answer: string; waitId: string } {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_question_answer requires an object input.");
    return { answer: text(record.answer, "answer"), waitId: text(record.waitId, "waitId") };
}

function readApprovalDecision(input: JsonValue): { approvalId: string; decision: "approve" | "deny" } {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_approval_decide requires an object input.");
    const decision = record.decision;
    if (decision !== "approve" && decision !== "deny") throw new Error("decision must be approve or deny.");
    return { approvalId: text(record.approvalId, "approvalId"), decision };
}

function readGoalFence(input: JsonValue, toolName: string): { goalId: string; revision: number } {
    const record = asRecord(input);
    if (record === undefined) throw new Error(`${toolName} requires an object input.`);
    const revision = record.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
        throw new Error(`${toolName} revision must be a positive integer.`);
    }
    return { goalId: text(record.goalId, "goalId"), revision };
}

function readTaskControl(input: JsonValue): { action: TodoTaskControlAction; revision: number; taskId: string } {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_task_control requires an object input.");
    const action = record.action;
    if (action !== "pause" && action !== "resume" && action !== "cancel") {
        throw new Error("action must be pause, resume, or cancel.");
    }
    const revision = record.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
        throw new Error("workspace_task_control revision must be a positive integer.");
    }
    return { action, revision, taskId: text(record.taskId, "taskId") };
}

function readWaitId(input: JsonValue, toolName: string): string {
    const record = asRecord(input);
    if (record === undefined) throw new Error(`${toolName} requires an object input.`);
    return text(record.waitId, "waitId");
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
    throw new Error("action must be claim, attempt, sent, complete, release, reject, or dismiss.");
}

function readWorkspaceCursor(input: JsonValue): number {
    const record = asRecord(input);
    const cursor = record?.cursor;
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("workspace_watch cursor must be a non-negative integer.");
    }
    return cursor;
}

function taskBelongsToContext(todo: Record<string, JsonValue>, taskId: string, ctxId: string): boolean {
    if (!Array.isArray(todo.tasks)) return false;
    return todo.tasks.some((entry) => {
        const task = asRecord(entry);
        return task?.taskId === taskId && task.ctxId === ctxId;
    });
}

async function currentTodoAssociation(
    gateway: McpInteractionGateway,
    instance: string,
    ctxId: string,
): Promise<
    | { kind: "none" }
    | { kind: "ambiguous" }
    | { kind: "one"; revision: number; taskId: string; todoItemId: string }
> {
    const todo = asRecord(await gateway.readTodo(instance));
    if (!Array.isArray(todo?.tasks)) return { kind: "none" };
    const active = todo.tasks.map(asRecord).filter((task) => (
        task?.ctxId === ctxId && task.status === "in_progress" && typeof task.taskId === "string"
    ));
    if (active.length === 0) return { kind: "none" };
    if (active.length !== 1) return { kind: "ambiguous" };
    const taskId = active[0]?.taskId;
    if (typeof taskId !== "string") return { kind: "ambiguous" };
    const detail = asRecord(await gateway.readTodo(instance, { taskId }));
    if (!Array.isArray(detail?.items) || typeof detail.revision !== "number") return { kind: "ambiguous" };
    const current = detail.items.map(asRecord).filter((item) => item?.status === "in_progress" && typeof item.id === "string");
    if (current.length !== 1 || typeof current[0]?.id !== "string") return { kind: "ambiguous" };
    return { kind: "one", revision: detail.revision, taskId, todoItemId: current[0].id };
}

function validateQuestionAnswer(wait: WaitRecord, answer: string): void {
    const payload = asRecord(wait.payload) ?? {};
    const choices = Array.isArray(payload.choices)
        ? payload.choices.filter((choice): choice is string => typeof choice === "string")
        : [];
    if (payload.allowText === false && !choices.includes(answer)) {
        throw new Error("Answer must be one of the offered choices.");
    }
}

function readAnswer(result: JsonValue | undefined): string {
    const record = asRecord(result);
    if (record === undefined) throw new Error("Question resolved without an answer.");
    return text(record.answer, "answer");
}

function requireCtxId(context: ToolCallContext): string {
    if (typeof context.ctxId !== "string" || context.ctxId.length === 0) {
        throw new Error("Interaction tool requires a validated Context.");
    }
    return context.ctxId;
}

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length > 12) throw new Error(`${field} must be an array with at most 12 entries.`);
    return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function asRecord(value: unknown): { [key: string]: JsonValue } | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as { [key: string]: JsonValue }
        : undefined;
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
