import { randomUUID } from "node:crypto";

import type {
    ApprovalRequest,
    GoalContinuationInput,
    GoalManageInput,
    InstanceEvent,
    JsonValue,
    TodoTaskControlAction,
    ToolCallContext,
    WaitRecord
} from "@portable-devshell/shared";

import { createMcpContextSelector, type McpContextSelector } from "../../context/McpContextSelector.js";
import {
    isMcpGoalGateway,
    isMcpInteractionGateway,
    isMcpWaitRecoveryGateway,
    isMcpWaitTrackingGateway,
    isMcpWorkspaceGateway,
    type McpInstanceGateway,
    type McpInteractionGateway
} from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogInteractionName } from "../../tool/catalog/McpToolCatalogInteraction.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { McpNativeToolResult, type McpEndpointResult } from "../McpEndpointResult.js";

export class McpEndpointHandlerInteraction {
    readonly #appStates = new Map<string, { lastSeenAt?: number; token: string }>();
    readonly #contextSelector: McpContextSelector;

    constructor(private readonly options: {
        contextSelector?: McpContextSelector;
        gateway?: McpInstanceGateway;
        instanceName: string;
        now?: () => number;
        watchHeartbeatMs?: number;
        watchPollMs?: number;
        workspaceLivenessMs?: number;
    }) {
        this.#contextSelector = options.contextSelector ?? createMcpContextSelector("explicit");
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
                return this.#openWorkspace(context);
            case "workspace_reconnect":
                return await this.#reconnectWorkspace(gateway, context);
            case "workspace_snapshot":
                return await this.#readWorkspace(gateway, input, context);
            case "workspace_watch":
                return await this.#watchWorkspace(gateway, input, context, signal);
            case "workspace_question_answer":
                this.#assertAppToken(input, context);
                return await this.#answerQuestion(gateway, input, context);
            case "workspace_wait_interrupt":
                this.#assertAppToken(input, context);
                return await this.#interruptWait(gateway, input, context);
            case "workspace_task_control":
                this.#assertAppToken(input, context);
                return await this.#controlTask(gateway, input, context);
            case "workspace_wait_recover":
                this.#assertAppToken(input, context);
                return await this.#recoverWait(gateway, input, context);
            case "workspace_goal_continue":
                this.#assertAppToken(input, context);
                return await this.#continueGoal(gateway, input, context);
            case "workspace_goal_stop":
                this.#assertAppToken(input, context);
                return await this.#stopGoal(context);
            case "workspace_approval_decide":
                this.#assertAppToken(input, context);
                return await this.#decideApproval(gateway, input, context);
        }
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
        const app = this.#appStates.get(ctxId);
        const now = (this.options.now ?? Date.now)();
        if (
            app?.lastSeenAt === undefined ||
            now - app.lastSeenAt > (this.options.workspaceLivenessMs ?? 60_000)
        ) {
            const selector = this.#contextSelector.requiresExplicitContextId
                ? "this ctxId"
                : "the current host session";
            throw new Error(`workspace_ask requires an active Workspace App for ${selector}; call workspace_open and keep the panel open.`);
        }
        const goalGateway = isMcpGoalGateway(this.options.gateway) ? this.options.gateway : undefined;
        const goal = await goalGateway?.readGoal(this.options.instanceName, ctxId);
        const goalId = goal !== undefined && (goal.status === "active" || goal.status === "blocked")
            ? goal.goalId
            : undefined;
        const taskId = goalId === undefined
            ? currentTodoTaskId(await gateway.readTodo(this.options.instanceName), ctxId)
            : undefined;
        const questionId = `question-${randomUUID()}`;
        const wait = await gateway.createWait(this.options.instanceName, {
            createdByCtxId: ctxId,
            ...(goalId === undefined ? {} : { goalId }),
            kind: "question",
            ownerCallId: callId,
            payload: {
                allowText: request.allowText,
                choices: request.choices,
                question: request.question,
            },
            targetId: questionId,
            ...(taskId === undefined ? {} : { taskId }),
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

        const answer = readAnswer(resolved.result);
        await gateway.consumeWait(this.options.instanceName, wait.waitId);
        await gateway.touchGoal?.(this.options.instanceName, ctxId);
        return { answer, questionId };
    }

    #openWorkspace(context: ToolCallContext): McpNativeToolResult {
        const ctxId = requireCtxId(context);
        return this.#workspaceResult(ctxId, {
            contextSelector: {
                requiresExplicitContextId: this.#contextSelector.requiresExplicitContextId,
            },
            ...(this.#contextSelector.requiresExplicitContextId ? { ctxId } : {}),
            instance: this.options.instanceName,
        }, [
            { type: "text", text: "portable-devshell Workspace opened." }
        ], false);
    }

    async #manageGoal(input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
        const request = readGoalManageInput(input);
        const ctxId = requireCtxId(context);
        if (request.action === "start") {
            const app = this.#appStates.get(ctxId);
            const now = (this.options.now ?? Date.now)();
            if (
                app?.lastSeenAt === undefined ||
                now - app.lastSeenAt > (this.options.workspaceLivenessMs ?? 60_000)
            ) {
                const selector = this.#contextSelector.requiresExplicitContextId
                    ? "this ctxId"
                    : "the current host session";
                throw new Error(`workspace_goal start requires an active Workspace App for ${selector}; call workspace_open and wait for the panel to connect.`);
            }
        }
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            request,
            ctxId,
        );
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
        if (request.action !== "report") {
            const [waits, approvals] = await Promise.all([
                interactionGateway.listWaits(this.options.instanceName),
                interactionGateway.listApprovals(this.options.instanceName),
            ]);
            request.available = request.available !== false &&
                !waits.some((wait) => (
                    wait.createdByCtxId === ctxId && wait.status !== "consumed" && wait.status !== "cancelled"
                )) &&
                !approvals.some((approval) => approval.ctxId === ctxId && approval.status === "pending");
        }
        return await goalGateway.goalContinuation(
            this.options.instanceName,
            request,
            ctxId,
        );
    }

    async #stopGoal(context: ToolCallContext): Promise<JsonValue> {
        const gateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            { action: "stop" },
            requireCtxId(context),
        );
        return { goal: goal ?? null } as unknown as JsonValue;
    }

    async #readWorkspace(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        this.#assertAppToken(input, context);
        return this.#workspaceResult(ctxId, await this.#snapshot(gateway, context));
    }

    async #reconnectWorkspace(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        return this.#workspaceResult(ctxId, await this.#snapshot(gateway, context), [], true, true);
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
        this.#assertAppToken(input, context);
        const startedAt = Date.now();
        const heartbeatMs = this.options.watchHeartbeatMs ?? 20_000;
        const pollMs = this.options.watchPollMs ?? 250;
        let cursor = readWorkspaceCursor(input);

        while (true) {
            const batch = await gateway.readWorkspaceEvents(this.options.instanceName, cursor + 1);
            const changed = batch.gap || batch.lastSeq < cursor || batch.events.some((event) => workspaceEventBelongsTo(event, ctxId));
            cursor = batch.lastSeq;
            if (changed) {
                return this.#workspaceResult(ctxId, {
                    changed: true,
                    cursor,
                    snapshot: await this.#snapshot(gateway, context),
                });
            }
            if (Date.now() - startedAt >= heartbeatMs) {
                return this.#workspaceResult(ctxId, { changed: false, cursor });
            }
            await waitForMcpEndpointAbortable(delay(pollMs), signal);
        }
    }

    #workspaceResult(
        ctxId: string,
        structuredContent: JsonValue,
        content: McpNativeToolResult["content"] = [],
        markAppSeen = true,
        rotateToken = false,
    ): McpNativeToolResult {
        const existing = this.#appStates.get(ctxId);
        const token = rotateToken || existing === undefined ? randomUUID() : existing.token;
        this.#appStates.set(ctxId, {
            ...(markAppSeen ? { lastSeenAt: (this.options.now ?? Date.now)() } : {}),
            token,
        });
        return new McpNativeToolResult({
            _meta: { "portable-devshell/workspace": { token } },
            content,
            structuredContent,
        });
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
        return {
            answer,
            detached: wait.status === "detached",
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
        return {
            detached: wait.status === "detached",
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
        const { action, taskId } = readTaskControl(input);
        const ctxId = requireCtxId(context);
        const task = asRecord(await gateway.readTodo(this.options.instanceName, { taskId }));
        if (task?.taskId !== taskId || !taskBelongsToContext(task, taskId, ctxId)) {
            throw new Error(`Todo task ${taskId} is not attached to the current Context.`);
        }
        return await gateway.controlTodo(this.options.instanceName, taskId, action, ctxId);
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
        if (recovery.action === "sent") {
            const sent = await gateway.markWaitRecoverySent(this.options.instanceName, waitId, recovery.claimId);
            return {
                ...(sent.recoveryMessageId === undefined ? {} : { recoveryMessageId: sent.recoveryMessageId }),
                ...(sent.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: sent.recoveryMessageSentAt }),
                sent: true,
                waitId: sent.waitId,
            };
        }
        if (recovery.action === "release") {
            await gateway.releaseWaitRecovery(this.options.instanceName, waitId, recovery.claimId);
            return { released: true, waitId };
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
        const ctxId = requireCtxId(context);
        if (wait.goalId !== undefined) {
            const goalGateway = requireGoalGateway(this.options.gateway, this.options.instanceName);
            const goal = await goalGateway.readGoal(this.options.instanceName, ctxId);
            if (
                goal?.goalId !== wait.goalId ||
                (goal.status !== "active" && goal.status !== "blocked")
            ) {
                throw new Error(`Workspace Goal ${wait.goalId} is not available for automatic recovery.`);
            }
        } else if (wait.taskId !== undefined) {
            const todo = asRecord(await gateway.readTodo(this.options.instanceName));
            const task = Array.isArray(todo?.tasks)
                ? todo.tasks.map(asRecord).find((entry) => (
                    entry?.taskId === wait.taskId && entry?.ctxId === ctxId
                ))
                : undefined;
            if (task === undefined || task.status === "paused") {
                throw new Error(`Durable task ${wait.taskId} is not available for automatic recovery.`);
            }
        }
        const claimId = `recovery-${randomUUID()}`;
        const claimed = await gateway.claimWaitRecovery(this.options.instanceName, waitId, claimId);
        return {
            claimId,
            ...(claimed.goalId === undefined ? {} : { goalId: claimed.goalId }),
            kind: claimed.kind,
            ...(claimed.result === undefined ? {} : { result: claimed.result }),
            ...(claimed.recoveryMessageId === undefined ? {} : { recoveryMessageId: claimed.recoveryMessageId }),
            ...(claimed.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: claimed.recoveryMessageSentAt }),
            ...(claimed.taskId === undefined ? {} : { taskId: claimed.taskId }),
            targetId: claimed.targetId,
            waitId: claimed.waitId,
        };
    }

    async #decideApproval(
        gateway: McpInteractionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const { approvalId, decision } = readApprovalDecision(input);
        const ctxId = requireCtxId(context);
        const approval = (await gateway.listApprovals(this.options.instanceName)).find((entry) => entry.approvalId === approvalId);
        if (approval === undefined || approval.ctxId !== ctxId || approval.status !== "pending") {
            throw new Error(`Pending approval ${approvalId} was not found for the current Context.`);
        }
        const decided = await gateway.decideApproval(this.options.instanceName, approvalId, decision);
        const { ctxId: _ctxId, ...visible } = decided;
        return visible as unknown as JsonValue;
    }

    async #snapshot(gateway: McpInteractionGateway, context: ToolCallContext): Promise<JsonValue> {
        const ctxId = requireCtxId(context);
        const workspaceGateway = isMcpWorkspaceGateway(gateway) ? gateway : undefined;
        const goalGateway = isMcpGoalGateway(gateway) ? gateway : undefined;
        const [todo, waits, approvals, eventSlice, goal] = await Promise.all([
            gateway.readTodo(this.options.instanceName),
            gateway.listWaits(this.options.instanceName),
            gateway.listApprovals(this.options.instanceName),
            workspaceGateway?.readWorkspaceEvents(this.options.instanceName, Number.MAX_SAFE_INTEGER) ?? {
                events: [],
                gap: false,
                lastSeq: 0,
            },
            goalGateway?.readGoal(this.options.instanceName, ctxId),
        ]);
        const todoRecord = asRecord(todo);
        const tasks = Array.isArray(todoRecord?.tasks)
            ? todoRecord.tasks.filter((task) => asRecord(task)?.ctxId === ctxId)
            : [];
        const ownedWaits = waits.filter((wait) => wait.createdByCtxId === ctxId);
        const ownedApprovals = approvals.filter((approval) => approval.ctxId === ctxId && approval.status === "pending");
        const visibleTasks = tasks.flatMap((task) => {
            const record = asRecord(task);
            if (record === undefined) return [];
            const { ctxId: _ctxId, ...visible } = record;
            return [visible];
        });
        const visibleWaits = ownedWaits.map((wait) => {
            const {
                createdByCtxId: _createdByCtxId,
                ownerCallId: _ownerCallId,
                recoveryClaimedAt: _recoveryClaimedAt,
                recoveryClaimId: _recoveryClaimId,
                ...visible
            } = wait;
            return visible;
        });
        const visibleApprovals = ownedApprovals.map((approval) => {
            const { ctxId: _ctxId, ...visible } = approval;
            return visible;
        });
        return {
            approvals: visibleApprovals,
            background: ownedWaits
                .filter((wait) => wait.kind === "tmux" && wait.status !== "consumed" && wait.status !== "cancelled")
                .map((wait) => ({
                    ...(wait.detachedAt === undefined ? {} : { detachedAt: wait.detachedAt }),
                    ...(wait.goalId === undefined ? {} : { goalId: wait.goalId }),
                    status: wait.status,
                    ...(wait.taskId === undefined ? {} : { taskId: wait.taskId }),
                    tmuxTaskId: wait.targetId,
                    updatedAt: wait.updatedAt,
                    waitId: wait.waitId,
                })),
            contextSelector: {
                requiresExplicitContextId: this.#contextSelector.requiresExplicitContextId,
            },
            ...(this.#contextSelector.requiresExplicitContextId ? { ctxId } : {}),
            currentEvent: workspaceCurrentEvent(ownedWaits, ownedApprovals),
            cursor: eventSlice.lastSeq,
            goal: goal ?? null,
            instance: this.options.instanceName,
            questions: visibleWaits.filter((wait) => wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached")),
            tasks: visibleTasks,
        } as unknown as JsonValue;
    }

    #assertAppToken(input: JsonValue, context: ToolCallContext): void {
        const ctxId = requireCtxId(context);
        const record = asRecord(input);
        const token = record === undefined ? undefined : record.token;
        if (typeof token !== "string" || token !== this.#appStates.get(ctxId)?.token) {
            throw new Error("Workspace App authorization is invalid for the current Context.");
        }
    }
}

function workspaceCurrentEvent(waits: WaitRecord[], approvals: ApprovalRequest[]): JsonValue {
    const candidates: Array<{ rank: number; updatedAt: string; value: JsonValue }> = [];
    for (const approval of approvals) {
        candidates.push({
            rank: 0,
            updatedAt: approval.createdAt,
            value: {
                eventName: "approval.decision",
                approvalId: approval.approvalId,
                inputSummary: approval.inputSummary,
                kind: "approval",
                name: approval.toolName,
                reason: approval.reason,
                riskLevel: approval.riskLevel,
                status: "waiting",
                toolName: approval.toolName,
                updatedAt: approval.createdAt,
            },
        });
    }
    for (const wait of waits) {
        if (wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached")) {
            candidates.push({
                rank: wait.status === "waiting" ? 0 : 1,
                updatedAt: wait.updatedAt,
                value: {
                    eventName: "user.answer",
                    kind: "question",
                    name: "workspace_ask",
                    ...(wait.payload === undefined ? {} : { payload: wait.payload }),
                    ...(wait.goalId === undefined ? {} : { goalId: wait.goalId }),
                    status: wait.status,
                    ...(wait.taskId === undefined ? {} : { taskId: wait.taskId }),
                    updatedAt: wait.updatedAt,
                    waitId: wait.waitId,
                },
            });
        }
        if (wait.kind === "tmux" && wait.status === "waiting") {
            candidates.push({
                rank: 0,
                updatedAt: wait.updatedAt,
                value: {
                    eventName: "tmux.task.completed",
                    kind: "tmux",
                    name: "tmux_run",
                    ...(wait.goalId === undefined ? {} : { goalId: wait.goalId }),
                    status: wait.status,
                    ...(wait.taskId === undefined ? {} : { taskId: wait.taskId }),
                    tmuxTaskId: wait.targetId,
                    updatedAt: wait.updatedAt,
                    waitId: wait.waitId,
                },
            });
        }
    }
    candidates.sort((left, right) => left.rank - right.rank || right.updatedAt.localeCompare(left.updatedAt));
    return candidates[0]?.value ?? null;
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
    if (action !== "claim" && action !== "validate" && action !== "report") {
        throw new Error("workspace_goal_continue action must be claim, validate, or report.");
    }
    return {
        action,
        ...(typeof record.accepted === "boolean" ? { accepted: record.accepted } : {}),
        ...(typeof record.available === "boolean" ? { available: record.available } : {}),
        ...(typeof record.claimId === "string" ? { claimId: record.claimId } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
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

function readTaskControl(input: JsonValue): { action: TodoTaskControlAction; taskId: string } {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_task_control requires an object input.");
    const action = record.action;
    if (action !== "pause" && action !== "resume" && action !== "cancel") {
        throw new Error("action must be pause, resume, or cancel.");
    }
    return { action, taskId: text(record.taskId, "taskId") };
}

function readWaitId(input: JsonValue, toolName: string): string {
    const record = asRecord(input);
    if (record === undefined) throw new Error(`${toolName} requires an object input.`);
    return text(record.waitId, "waitId");
}

function readWaitRecovery(input: JsonValue):
    | { action: "claim"; waitId: string }
    | { action: "complete" | "release" | "sent"; claimId: string; waitId: string } {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_wait_recover requires an object input.");
    const action = record.action;
    const waitId = text(record.waitId, "waitId");
    if (action === "claim") return { action, waitId };
    if (action === "complete" || action === "release" || action === "sent") {
        return { action, claimId: text(record.claimId, "claimId"), waitId };
    }
    throw new Error("action must be claim, sent, complete, or release.");
}

function readWorkspaceCursor(input: JsonValue): number {
    const record = asRecord(input);
    const cursor = record?.cursor;
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("workspace_watch cursor must be a non-negative integer.");
    }
    return cursor;
}

function workspaceEventBelongsTo(event: InstanceEvent, ctxId: string): boolean {
    const data = asRecord(event.data);
    return data?.ctxId === ctxId || data?.createdByCtxId === ctxId;
}

function taskBelongsToContext(todo: Record<string, JsonValue>, taskId: string, ctxId: string): boolean {
    if (!Array.isArray(todo.tasks)) return false;
    return todo.tasks.some((entry) => {
        const task = asRecord(entry);
        return task?.taskId === taskId && task.ctxId === ctxId;
    });
}

function currentTodoTaskId(todo: JsonValue, ctxId: string): string | undefined {
    const record = asRecord(todo);
    if (!Array.isArray(record?.tasks)) return undefined;
    const active = record.tasks.map(asRecord).filter((task) => (
        task?.ctxId === ctxId && task.status === "in_progress" && typeof task.taskId === "string"
    ));
    return active.length === 1 ? active[0]?.taskId as string : undefined;
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
