import { randomUUID } from "node:crypto";

import type {
    ApprovalRequest,
    InstanceEvent,
    JsonValue,
    TodoTaskControlAction,
    ToolCallContext,
    ToolCallRecord,
    WaitRecord
} from "@portable-devshell/shared";

import { createMcpContextSelector, type McpContextSelector } from "../../context/McpContextSelector.js";
import {
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
    readonly #appStates = new Map<string, { lastSeenAt: number; token: string }>();
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
            case "ask_question":
                return await this.#askQuestion(gateway, input, context, callId, signal);
            case "workspace_open":
                return await this.#openWorkspace(gateway, context);
            case "workspace_snapshot":
                return await this.#readWorkspace(gateway, context);
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
        if (app === undefined || now - app.lastSeenAt > (this.options.workspaceLivenessMs ?? 60_000)) {
            const selector = this.#contextSelector.requiresExplicitContextId
                ? "this ctxId"
                : "the current host session";
            throw new Error(`ask_question requires an active Workspace App for ${selector}; call workspace_open again.`);
        }
        const task = await gateway.readTodo(this.options.instanceName, { taskId: request.taskId });
        const taskRecord = asRecord(task);
        if (taskRecord?.taskId !== request.taskId || !taskBelongsToContext(taskRecord, request.taskId, ctxId)) {
            throw new Error(`Todo task ${request.taskId} is not attached to the current Context.`);
        }
        const questionId = `question-${randomUUID()}`;
        const wait = await gateway.createWait(this.options.instanceName, {
            createdByCtxId: ctxId,
            kind: "question",
            ownerCallId: callId,
            payload: {
                allowText: request.allowText,
                choices: request.choices,
                question: request.question,
            },
            targetId: questionId,
            taskId: request.taskId,
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
        return { answer, questionId };
    }

    async #openWorkspace(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        return this.#workspaceResult(ctxId, await this.#snapshot(gateway, context), [
            { type: "text", text: "portable-devshell Workspace opened." }
        ]);
    }

    async #readWorkspace(
        gateway: McpInteractionGateway,
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        return this.#workspaceResult(ctxId, await this.#snapshot(gateway, context));
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
    ): McpNativeToolResult {
        const existing = this.#appStates.get(ctxId);
        const token = existing?.token ?? randomUUID();
        this.#appStates.set(ctxId, {
            lastSeenAt: (this.options.now ?? Date.now)(),
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
            wait.kind !== "tmux" || wait.status !== "waiting"
        ) {
            throw new Error(`Interruptible tmux wait ${waitId} was not found for the current Context.`);
        }
        const cancelled = await gateway.cancelWait(this.options.instanceName, waitId);
        return {
            interrupted: true,
            status: cancelled.status,
            tmuxTaskId: cancelled.targetId,
            waitId: cancelled.waitId,
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
        if (wait.taskId === undefined) {
            throw new Error(`Recoverable detached wait ${waitId} is not attached to a durable task.`);
        }
        const todo = asRecord(await gateway.readTodo(this.options.instanceName));
        const task = Array.isArray(todo?.tasks)
            ? todo.tasks.map(asRecord).find((entry) => (
                entry?.taskId === wait.taskId && entry?.ctxId === requireCtxId(context)
            ))
            : undefined;
        if (task === undefined || task.status === "paused") {
            throw new Error(`Durable task ${wait.taskId} is not available for automatic recovery.`);
        }
        const claimId = `recovery-${randomUUID()}`;
        const claimed = await gateway.claimWaitRecovery(this.options.instanceName, waitId, claimId);
        return {
            claimId,
            kind: claimed.kind,
            ...(claimed.result === undefined ? {} : { result: claimed.result }),
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
        const [todo, waits, approvals, activity, eventSlice] = await Promise.all([
            gateway.readTodo(this.options.instanceName),
            gateway.listWaits(this.options.instanceName),
            gateway.listApprovals(this.options.instanceName),
            workspaceGateway?.readToolCalls(this.options.instanceName, ctxId, 30) ?? [],
            workspaceGateway?.readWorkspaceEvents(this.options.instanceName, Number.MAX_SAFE_INTEGER) ?? {
                events: [],
                gap: false,
                lastSeq: 0,
            },
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
            activity: activity
                .filter((record) => !record.toolName.startsWith("workspace_"))
                .slice()
                .reverse()
                .map(workspaceActivity),
            approvals: visibleApprovals,
            background: ownedWaits
                .filter((wait) => wait.kind === "tmux" && wait.status !== "consumed" && wait.status !== "cancelled")
                .map((wait) => ({
                    ...(wait.detachedAt === undefined ? {} : { detachedAt: wait.detachedAt }),
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
                    name: "ask_question",
                    ...(wait.payload === undefined ? {} : { payload: wait.payload }),
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
                    name: "tmux_wait",
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

function readQuestion(input: JsonValue): {
    allowText: boolean;
    choices: string[];
    question: string;
    taskId: string;
} {
    const record = asRecord(input);
    if (record === undefined) throw new Error("ask_question requires an object input.");
    const taskId = text(record.taskId, "taskId");
    const question = text(record.question, "question");
    const choices = record.choices === undefined ? [] : stringArray(record.choices, "choices");
    const allowText = record.allowText === undefined ? true : record.allowText;
    if (typeof allowText !== "boolean") throw new Error("allowText must be a boolean.");
    if (!allowText && choices.length === 0) throw new Error("ask_question requires choices when allowText is false.");
    return { allowText, choices, question, taskId };
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
    | { action: "complete" | "release"; claimId: string; waitId: string } {
    const record = asRecord(input);
    if (record === undefined) throw new Error("workspace_wait_recover requires an object input.");
    const action = record.action;
    const waitId = text(record.waitId, "waitId");
    if (action === "claim") return { action, waitId };
    if (action === "complete" || action === "release") {
        return { action, claimId: text(record.claimId, "claimId"), waitId };
    }
    throw new Error("action must be claim, complete, or release.");
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

function workspaceActivity(record: ToolCallRecord): JsonValue {
    return {
        callId: record.callId,
        ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
        ...(record.error === undefined ? {} : { error: record.error }),
        inputSummary: record.inputSummary,
        startedAt: record.startedAt,
        status: record.status,
        ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
        ...(record.todoItemId === undefined ? {} : { todoItemId: record.todoItemId }),
        toolName: record.toolName,
    };
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
