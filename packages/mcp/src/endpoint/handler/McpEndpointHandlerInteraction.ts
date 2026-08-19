import { randomUUID } from "node:crypto";

import type { InstanceEvent, JsonValue, ToolCallContext, ToolCallRecord, WaitRecord } from "@portable-devshell/shared";

import {
    isMcpInteractionGateway,
    isMcpWorkspaceGateway,
    type McpInstanceGateway,
    type McpInteractionGateway
} from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogInteractionName } from "../../tool/catalog/McpToolCatalogInteraction.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { McpNativeToolResult, type McpEndpointResult } from "../McpEndpointResult.js";

export class McpEndpointHandlerInteraction {
    readonly #appTokens = new Map<string, string>();

    constructor(private readonly options: {
        gateway?: McpInstanceGateway;
        instanceName: string;
        watchHeartbeatMs?: number;
        watchPollMs?: number;
    }) {}

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
        if (!this.#appTokens.has(ctxId)) {
            throw new Error("ask_question requires workspace_open to be called first for this ctxId.");
        }
        const task = await gateway.readTodo(this.options.instanceName, { taskId: request.taskId });
        const taskRecord = asRecord(task);
        if (taskRecord?.taskId !== request.taskId) {
            throw new Error(`Todo task ${request.taskId} was not found.`);
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
        const snapshot = await this.#snapshot(gateway, context);
        return this.#workspaceResult(ctxId, snapshot, [
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
        let token = this.#appTokens.get(ctxId);
        if (token === undefined) {
            token = randomUUID();
            this.#appTokens.set(ctxId, token);
        }
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
            throw new Error(`Question wait ${waitId} was not found for this ctxId.`);
        }
        validateQuestionAnswer(wait, answer);
        const resolved = await gateway.resolveWait(this.options.instanceName, waitId, { answer });
        return { answer, questionId: resolved.targetId, waitId: resolved.waitId };
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
            throw new Error(`Pending approval ${approvalId} was not found for this ctxId.`);
        }
        return await gateway.decideApproval(this.options.instanceName, approvalId, decision) as unknown as JsonValue;
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
        return {
            activity: activity
                .filter((record) => !record.toolName.startsWith("workspace_"))
                .slice()
                .reverse()
                .map(workspaceActivity),
            approvals: approvals.filter((approval) => approval.ctxId === ctxId && approval.status === "pending"),
            background: ownedWaits
                .filter((wait) => wait.kind === "tmux" && wait.status !== "consumed" && wait.status !== "cancelled")
                .map((wait) => ({
                    ...(wait.detachedAt === undefined ? {} : { detachedAt: wait.detachedAt }),
                    status: wait.status,
                    tmuxTaskId: wait.targetId,
                    updatedAt: wait.updatedAt,
                    waitId: wait.waitId,
                })),
            ctxId,
            cursor: eventSlice.lastSeq,
            instance: this.options.instanceName,
            questions: ownedWaits.filter((wait) => wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached")),
            tasks,
            waits: ownedWaits.filter((wait) => wait.status !== "consumed" && wait.status !== "cancelled"),
        } as unknown as JsonValue;
    }

    #assertAppToken(input: JsonValue, context: ToolCallContext): void {
        const ctxId = requireCtxId(context);
        const record = asRecord(input);
        const token = record === undefined ? undefined : record.token;
        if (typeof token !== "string" || token !== this.#appTokens.get(ctxId)) {
            throw new Error("Workspace App authorization is invalid for this ctxId.");
        }
    }
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
        throw new Error("Interaction tool requires a validated ctxId.");
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
