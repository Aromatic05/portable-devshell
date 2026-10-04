import type {
    GoalManageInput,
    JsonValue,
    TodoTaskControlAction,
    ToolCallContext,
} from "@portable-devshell/shared";

import {
    isMcpAppGateway,
    requireMcpGoalGateway as requireGoalGateway,
    requireMcpAppActionGateway as requireInteractionGateway,
    type McpAppActionGateway,
    type McpAppPort,
} from "../../instance/Gateway.js";
import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { McpToolCatalogMcpAppName } from "./Catalog.js";
import { readMcpAppSnapshot } from "../../mcpapp/Projection.js";
import {
    readContextWorkspaceSnapshot,
    readMcpAppContextInstances,
} from "../../mcpapp/ContextScope.js";
import { mcpAppEventBelongsTo } from "../../mcpapp/contributor/Activity.js";
import { McpAppLeaseStore } from "../../mcpapp/app/Lease.js";
import { McpAppPresenceStore } from "../../mcpapp/app/Presence.js";
import { McpAppActionStore } from "../../mcpapp/ActionStore.js";
import { executeWorkspaceAction } from "../../mcpapp/Action.js";
import type { McpAppActionEffect, McpAppActionRequest, McpAppResolvedAction } from "../../mcpapp/model/Contract.js";
import {
    waitForMcpEndpointAbortable,
} from "../call/Boundary.js";
import { McpNativeToolResult, type McpEndpointResult } from "../call/Boundary.js";

export class McpEndpointHandlerMcpApp {
    readonly #appLeases: McpAppLeaseStore;
    readonly #appPresence: McpAppPresenceStore;
    readonly #actionStore: McpAppActionStore;

    constructor(
        private readonly options: {
            contextRegistry?: ContextRegistryPort;
            gateway?: McpAppPort;
            instanceName: string;
            now?: () => number;
            watchHeartbeatMs?: number;
            watchPollMs?: number;
            mcpAppActivationGraceMs?: number;
            mcpAppLivenessMs?: number;
            mcpAppLeases?: McpAppLeaseStore;
            mcpAppPresence?: McpAppPresenceStore;
            mcpAppActionStore?: McpAppActionStore;
            mcpAppLiveBaseUrl?: string;
        },
    ) {
        this.#appLeases =
            options.mcpAppLeases ?? new McpAppLeaseStore();
        this.#actionStore = options.mcpAppActionStore ?? new McpAppActionStore();
        this.#appPresence =
            options.mcpAppPresence ??
            new McpAppPresenceStore({ now: options.now });
    }

    async call(
        toolName: McpToolCatalogMcpAppName,
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        const gateway = requireInteractionGateway(
            this.options.gateway,
            this.options.instanceName,
        );
        switch (toolName) {
            case "mcpapp_goal":
                return await this.#manageGoal(input, context);
            case "mcpapp_open":
                return await this.#openWorkspace(context);
            case "mcpapp_reconnect":
                return await this.#readWorkspace(gateway, input, context);
            case "mcpapp_snapshot":
                return await this.#readWorkspace(gateway, input, context);
            case "mcpapp_watch":
                return await this.#watchWorkspace(
                    gateway,
                    input,
                    context,
                    signal,
                );
            case "mcpapp_action":
                await this.#assertAppToken(input, context);
                return await this.#mcpAppAction(gateway, input, context);
        }
    }

    async bootstrapWorkspace(
        ctxId: string,
        structuredContent: JsonValue,
        content: McpNativeToolResult["content"] = [],
    ): Promise<McpNativeToolResult> {
        const token = await this.#appLeases.issue(
            this.options.instanceName,
            ctxId,
        );
        this.#appPresence.open(this.options.instanceName, ctxId);
        return this.#mcpAppResult(
            ctxId,
            token,
            structuredContent,
            content,
            false,
        );
    }

    async #openWorkspace(
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        return await this.bootstrapWorkspace(
            ctxId,
            {
                ctxId,
                instance: this.options.instanceName,
            },
            [{ type: "text", text: "portable-devshell McpApp opened." }],
        );
    }

    async #manageGoal(
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const gateway = requireGoalGateway(
            this.options.gateway,
            this.options.instanceName,
        );
        const request = readGoalManageInput(input);
        const ctxId = requireCtxId(context);
        request.workspace = context.workspace;
        if (request.action === "start") {
            this.#requirePresentedWorkspace(
                ctxId,
                "mcpapp_goal start requires an initialized McpApp for this ctxId. Call environ_info with workspace to initialize it before starting a Goal.",
            );
        }
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            request,
            ctxId,
        );
        if (request.action === "block" || request.action === "stop") {
            await this.#actionStore.suppressContextPending(ctxId);
        }
        if (request.action === "start") {
            await this.options.contextRegistry?.reentry.resumeAutomaticReentry(
                ctxId,
                this.options.instanceName,
            );
        } else if (request.action !== "get") {
            await this.options.contextRegistry?.reentry.observeAutomaticReentryActivity(
                ctxId,
                this.options.instanceName,
                request.action === "block"
                    ? "wait"
                    : request.action === "update" &&
                        request.objective === undefined &&
                        request.steps === undefined &&
                        request.stepId === undefined
                      ? "observation"
                      : "mutation",
            );
        }
        return { goal: goal ?? null } as unknown as JsonValue;
    }

    async #controlGoal(
        command: "pause" | "stop" | "resume",
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const gateway = requireGoalGateway(
            this.options.gateway,
            this.options.instanceName,
        );
        const fence = readGoalFence(input, `goal-${command}`);
        const ctxId = requireCtxId(context);
        const goal = await gateway.manageGoal(
            this.options.instanceName,
            {
                action: command,
                expectedGoalId: fence.goalId,
                expectedRevision: fence.revision,
                ...(command === "stop" ? {} : { userControl: true }),
                workspace: context.workspace,
            },
            ctxId,
        );
        if (command === "pause") {
            await this.options.contextRegistry?.reentry.suppressAutomaticReentry(
                ctxId,
                this.options.instanceName,
                "McpApp Goal paused by user",
                "paused",
            );
        } else if (command === "stop") {
            await this.options.contextRegistry?.reentry.suppressAutomaticReentry(
                ctxId,
                this.options.instanceName,
                "McpApp Goal stopped by user",
            );
        } else {
            await this.options.contextRegistry?.reentry.resumeAutomaticReentry(
                ctxId,
                this.options.instanceName,
            );
        }
        return { goal: goal ?? null } as unknown as JsonValue;
    }

    async #readWorkspace(
        gateway: McpAppActionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<McpNativeToolResult> {
        const ctxId = requireCtxId(context);
        const token = await this.#assertAppToken(input, context);
        return this.#mcpAppResult(
            ctxId,
            token,
            await this.#mcpAppSnapshot(gateway, ctxId),
        );
    }

    async #watchWorkspace(
        gateway: McpAppActionGateway,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<McpNativeToolResult> {
        if (!isMcpAppGateway(gateway)) {
            throw new Error(
                `McpApp live events are unavailable for ${this.options.instanceName}.`,
            );
        }
        const ctxId = requireCtxId(context);
        const token = await this.#assertAppToken(input, context);
        const startedAt = this.options.now?.() ?? Date.now();
        const instances = await this.#contextInstances(ctxId);
        const configuredHeartbeatMs = this.options.watchHeartbeatMs ?? 20_000;
        const heartbeatMs =
            instances.length > 1
                ? Math.min(configuredHeartbeatMs, 1_000)
                : configuredHeartbeatMs;
        const pollMs = this.options.watchPollMs ?? 250;
        let cursor = readWorkspaceCursor(input);
        this.#appPresence.beginWatch(this.options.instanceName, ctxId);
        try {
            while (true) {
                const batch = await gateway.readMcpAppEvents(
                    this.options.instanceName,
                    cursor + 1,
                );
                const changed =
                    batch.gap ||
                    batch.lastSeq < cursor ||
                    batch.events.some((event) =>
                        mcpAppEventBelongsTo(event, ctxId),
                    );
                cursor = batch.lastSeq;
                if (changed) {
                    return this.#mcpAppResult(ctxId, token, {
                        changed: true,
                        cursor,
                        snapshot: await this.#mcpAppSnapshot(gateway, ctxId),
                    });
                }
                if (
                    (this.options.now?.() ?? Date.now()) - startedAt >=
                    heartbeatMs
                ) {
                    return this.#mcpAppResult(ctxId, token, {
                        changed: false,
                        cursor,
                        snapshot: await this.#mcpAppSnapshot(gateway, ctxId),
                    });
                }
                await waitForMcpEndpointAbortable(delay(pollMs), signal);
            }
        } finally {
            this.#appPresence.endWatch(this.options.instanceName, ctxId);
        }
    }

    async #mcpAppSnapshot(
        gateway: McpAppActionGateway,
        ctxId: string,
    ): Promise<JsonValue> {
        const registry = this.options.contextRegistry;
        if (registry === undefined)
            return await readMcpAppSnapshot(
                gateway,
                this.options.instanceName,
                ctxId,
                { directives: await this.#actionStore.pendingDirectives(ctxId, this.options.instanceName) },
            );
        return await readContextWorkspaceSnapshot(
            registry,
            gateway,
            this.options.instanceName,
            ctxId,
            await this.#actionStore.pendingDirectives(
                ctxId,
                this.options.instanceName,
            ),
        );
    }

    async #mcpAppAction(
        gateway: McpAppActionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const request = readWorkspaceActionRequest(input);
        const ctxId = requireCtxId(context);
        return await executeWorkspaceAction(
            {
                store: this.#actionStore,
                instance: this.options.instanceName,
                contextInstances: async (id) => await this.#contextInstances(id),
                reentry: async (id) => this.options.contextRegistry === undefined
                    ? undefined
                    : await this.options.contextRegistry.reentry.readAutomaticReentry(id, this.options.instanceName) as unknown as JsonValue,
                snapshot: async (activeGateway, id, _directives) => {
                    const current = await this.#mcpAppSnapshot(activeGateway, id);
                    const record = asRecord(current);
                    return record as unknown as import("../../mcpapp/model/Contract.js").McpAppSnapshot;
                },
                mutate: async (action, actionRequest, actionContext) =>
                    await this.#mutateWorkspaceAction(gateway, action, actionRequest, actionContext),
            },
            gateway,
            request,
            { ...context, ctxId },
        );
    }

    async #mutateWorkspaceAction(
        gateway: McpAppActionGateway,
        action: McpAppResolvedAction,
        request: McpAppActionRequest,
        context: ToolCallContext,
    ): Promise<McpAppActionEffect | undefined> {
        const scoped = { ...context, instance: action.instance } as ToolCallContext;
        const target = action.targetId;
        switch (action.operation) {
            case "task-pause":
            case "task-cancel":
            case "task-resume":
                await this.#controlTask(gateway, { action: action.operation.slice(5), revision: action.revision, taskId: target } as unknown as JsonValue, scoped);
                if (action.operation === "task-pause" || action.operation === "task-cancel") {
                    await this.#actionStore.suppressContextPending(requireCtxId(context));
                }
                if (action.operation === "task-resume") return { kind: "reentry", intent: "task-resume", sourceId: target };
                return undefined;
            case "approval-approve":
            case "approval-deny":
                await this.#decideApproval(gateway, { approvalId: target, decision: action.operation.endsWith("approve") ? "approve" : "deny" } as unknown as JsonValue, scoped);
                return undefined;
            case "goal-pause":
                await this.#controlGoal("pause", { goalId: target, revision: action.revision } as unknown as JsonValue, scoped);
                await this.#actionStore.suppressContextPending(requireCtxId(context));
                return undefined;
            case "goal-resume":
                await this.#controlGoal("resume", { goalId: target, revision: action.revision } as unknown as JsonValue, scoped);
                return { kind: "reentry", intent: "goal-resume", sourceId: target };
            case "goal-retry":
                await this.options.contextRegistry?.reentry.resumeAutomaticReentry(
                    requireCtxId(context),
                    this.options.instanceName,
                );
                return { kind: "reentry", intent: "goal-retry", sourceId: target };
            case "goal-stop":
                await this.#controlGoal("stop", { goalId: target, revision: action.revision } as unknown as JsonValue, scoped);
                await this.#actionStore.suppressContextPending(requireCtxId(context));
                return undefined;
        }
    }

    async #contextInstances(ctxId: string): Promise<string[]> {
        const registry = this.options.contextRegistry;
        if (registry === undefined) return [this.options.instanceName];
        return await readMcpAppContextInstances(
            registry,
            this.options.instanceName,
            ctxId,
        );
    }

    #mcpAppResult(
        ctxId: string,
        token: string,
        structuredContent: JsonValue,
        content: McpNativeToolResult["content"] = [],
        markAppSeen = true,
    ): McpNativeToolResult {
        if (!this.#appPresence.has(this.options.instanceName, ctxId)) {
            throw new Error(
                "MCP App authorization is unavailable for the current Context.",
            );
        }
        if (markAppSeen)
            this.#appPresence.touch(this.options.instanceName, ctxId);
        return new McpNativeToolResult({
            _meta: {
                "portable-devshell/mcpapp": {
                    token,
                    ...(this.options.mcpAppLiveBaseUrl === undefined
                        ? {}
                        : { liveBaseUrl: this.options.mcpAppLiveBaseUrl }),
                },
            },
            content,
            structuredContent,
        });
    }

    #requirePresentedWorkspace(ctxId: string, message: string): void {
        if (this.#appPresence.has(this.options.instanceName, ctxId)) return;
        throw new Error(message);
    }

    async #controlTask(
        gateway: McpAppActionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        if (gateway.controlTodo === undefined) {
            throw new Error(
                `McpApp task control is unavailable for ${this.options.instanceName}.`,
            );
        }
        const { action, revision, taskId } = readTaskControl(input);
        const ctxId = requireCtxId(context);
        const task = asRecord(
            await gateway.readTodo(this.options.instanceName, { taskId }),
        );
        if (
            task?.taskId !== taskId ||
            !taskBelongsToContext(task, taskId, ctxId)
        ) {
            throw new Error(
                `Todo task ${taskId} is not attached to the current Context.`,
            );
        }
        const controlled = await gateway.controlTodo(
            this.options.instanceName,
            taskId,
            action,
            ctxId,
            revision,
        );
        if (action === "cancel") {
            await this.options.contextRegistry?.reentry.suppressAutomaticReentry(
                ctxId,
                this.options.instanceName,
                "McpApp task cancelled by user",
            );
        } else if (action === "pause") {
            await this.options.contextRegistry?.reentry.suppressAutomaticReentry(
                ctxId,
                this.options.instanceName,
                "McpApp task paused by user",
                "paused",
            );
        } else {
            await this.options.contextRegistry?.reentry.resumeAutomaticReentry(
                ctxId,
                this.options.instanceName,
            );
        }
        return controlled;
    }

    async #decideApproval(
        gateway: McpAppActionGateway,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const { approvalId, decision } = readApprovalDecision(input);
        const ctxId = requireCtxId(context);
        const instances = await this.#contextInstances(ctxId);
        let approval:
            | Awaited<
                  ReturnType<McpAppActionGateway["approval"]["listApprovals"]>
              >[number]
            | undefined;
        let approvalInstance: string | undefined;
        for (const instance of instances) {
            const candidate = (
                await gateway.approval.listApprovals(instance).catch(() => [])
            ).find((entry) => entry.approvalId === approvalId);
            if (candidate !== undefined) {
                approval = candidate;
                approvalInstance = instance;
                break;
            }
        }
        if (
            approval === undefined ||
            approvalInstance === undefined ||
            approval.ctxId !== ctxId ||
            approval.status !== "pending"
        ) {
            throw new Error(
                `Pending approval ${approvalId} was not found for the current Context.`,
            );
        }
        const decided = await gateway.approval.decideApproval!(
            approvalInstance,
            approvalId,
            decision,
        );
        const { ctxId: _ctxId, ...visible } = decided;
        return visible as unknown as JsonValue;
    }

    async #assertAppToken(
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<string> {
        const ctxId = requireCtxId(context);
        const record = asRecord(input);
        const token = record === undefined ? undefined : record.token;
        if (
            typeof token !== "string" ||
            token.length === 0 ||
            !(await this.#appLeases.verify(
                this.options.instanceName,
                ctxId,
                token,
            ))
        ) {
            throw new Error(
                "MCP App authorization is invalid for the current Context.",
            );
        }
        this.#appPresence.touch(this.options.instanceName, ctxId);
        return token;
    }
}

function readGoalManageInput(input: JsonValue): GoalManageInput {
    const record = asRecord(input);
    if (record === undefined)
        throw new Error("mcpapp_goal requires an object input.");
    const action = record.action;
    if (
        action !== "start" &&
        action !== "get" &&
        action !== "update" &&
        action !== "block" &&
        action !== "resume" &&
        action !== "finish" &&
        action !== "stop"
    ) {
        throw new Error(
            "mcpapp_goal action must be start, get, update, block, resume, finish, or stop.",
        );
    }
    return {
        action,
        ...(typeof record.note === "string" ? { note: record.note } : {}),
        ...(typeof record.objective === "string"
            ? { objective: record.objective }
            : {}),
        ...(typeof record.status === "string"
            ? { status: record.status as GoalManageInput["status"] }
            : {}),
        ...(typeof record.stepId === "string" ? { stepId: record.stepId } : {}),
        ...(Array.isArray(record.steps)
            ? { steps: record.steps as unknown as GoalManageInput["steps"] }
            : {}),
        ...(typeof record.text === "string" ? { text: record.text } : {}),
    };
}

function readWorkspaceActionRequest(input: JsonValue): McpAppActionRequest {
    const record = asRecord(input);
    if (record === undefined) throw new Error("mcpapp_action requires an object input.");
    if (record.input !== undefined && (typeof record.input !== "string" || record.input.length > 20_000)) {
        throw new Error("mcpapp_action input must be a string of at most 20000 characters.");
    }
    return {
        actionId: text(record.actionId, "actionId"),
        itemId: text(record.itemId, "itemId"),
        ...(typeof record.input === "string" ? { input: record.input } : {}),
    };
}

function readApprovalDecision(input: JsonValue): {
    approvalId: string;
    decision: "approve" | "deny";
} {
    const record = asRecord(input);
    if (record === undefined)
        throw new Error("mcpapp_action approval input is invalid.");
    const decision = record.decision;
    if (decision !== "approve" && decision !== "deny")
        throw new Error("decision must be approve or deny.");
    return { approvalId: text(record.approvalId, "approvalId"), decision };
}

function readGoalFence(
    input: JsonValue,
    toolName: string,
): { goalId: string; revision: number } {
    const record = asRecord(input);
    if (record === undefined)
        throw new Error(`${toolName} requires an object input.`);
    const revision = record.revision;
    if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1
    ) {
        throw new Error(`${toolName} revision must be a positive integer.`);
    }
    return { goalId: text(record.goalId, "goalId"), revision };
}

function readTaskControl(input: JsonValue): {
    action: TodoTaskControlAction;
    revision: number;
    taskId: string;
} {
    const record = asRecord(input);
    if (record === undefined)
        throw new Error("mcpapp_action task input is invalid.");
    const action = record.action;
    if (action !== "pause" && action !== "resume" && action !== "cancel") {
        throw new Error("action must be pause, resume, or cancel.");
    }
    const revision = record.revision;
    if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1
    ) {
        throw new Error("McpApp task revision must be a positive integer.");
    }
    return { action, revision, taskId: text(record.taskId, "taskId") };
}

function readWorkspaceCursor(input: JsonValue): number {
    const record = asRecord(input);
    const cursor = record?.cursor;
    if (
        typeof cursor !== "number" ||
        !Number.isSafeInteger(cursor) ||
        cursor < 0
    ) {
        throw new Error(
            "mcpapp_watch cursor must be a non-negative integer.",
        );
    }
    return cursor;
}

function taskBelongsToContext(
    todo: Record<string, JsonValue>,
    taskId: string,
    ctxId: string,
): boolean {
    if (!Array.isArray(todo.tasks)) return false;
    return todo.tasks.some((entry) => {
        const task = asRecord(entry);
        return task?.taskId === taskId && task.ctxId === ctxId;
    });
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

function asRecord(value: unknown): { [key: string]: JsonValue } | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as { [key: string]: JsonValue })
        : undefined;
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
