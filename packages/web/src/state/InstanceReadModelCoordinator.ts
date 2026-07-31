import type {
    ApprovalRequest,
    ContextMessageRecord,
    InstanceEvent,
    InstanceLogEntry,
    InstanceSnapshot,
    TodoReadResult,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";
import { ApprovalDecisionGuard } from "./ApprovalDecisionGuard.js";
import {
    mergeContextMessage,
    mergeContextMessageList,
} from "./ContextMessageState.js";
import {
    InstanceReadModelChannel,
    type InstanceReadModelAccess,
} from "./InstanceReadModelChannel.js";
import type { WebState } from "./WebState.js";

export interface InitialInstanceReadModels {
    approvals: Record<string, ApprovalRequest[]>;
    contextMessages: Record<string, ContextMessageRecord[]>;
    failures: Record<string, string>;
    logs: Record<string, InstanceLogEntry[]>;
    todos: Record<string, TodoReadResult>;
    toolCalls: Record<string, ToolCallRecord[]>;
}

export class InstanceReadModelCoordinator {
    readonly #snapshot: InstanceReadModelChannel<InstanceSnapshot>;
    readonly #logs: InstanceReadModelChannel<InstanceLogEntry[]>;
    readonly #approvals: InstanceReadModelChannel<ApprovalRequest[]>;
    readonly #todos: InstanceReadModelChannel<TodoReadResult>;
    readonly #toolCalls: InstanceReadModelChannel<ToolCallRecord[]>;
    readonly #contextMessages: InstanceReadModelChannel<ContextMessageRecord[]>;
    readonly #channels: readonly InstanceReadModelChannel<unknown>[];
    #authoritativeSnapshots = new Map<string, InstanceSnapshot>();

    constructor(
        clients: WebClients,
        private readonly access: InstanceReadModelAccess,
        private readonly approvalGuard: ApprovalDecisionGuard,
        readTimeoutMs = 10_000,
    ) {
        const channel = <T>(
            key: string,
            request: (instance: string) => Promise<T>,
            apply: (state: WebState, instance: string, value: T) => WebState,
        ) => new InstanceReadModelChannel({
            access,
            apply,
            key,
            request,
            timeoutMs: readTimeoutMs,
        });
        this.#snapshot = channel(
            "instance",
            async (instance) => (await clients.runtime.refresh(instance)).snapshot,
            (state, instance, snapshot) => this.applySnapshot(state, instance, snapshot),
        );
        this.#logs = channel(
            "logs",
            async (instance) => (await clients.runtime.readLogs(instance, { limit: 100 })).slice(-100),
            (state, instance, logs) => ({
                ...state,
                logs: { ...state.logs, [instance]: logs },
            }),
        );
        this.#approvals = channel(
            "approvals",
            (instance) => clients.tool.listApprovals(instance),
            (state, instance, approvals) => ({
                ...state,
                approvals: {
                    ...state.approvals,
                    [instance]: this.approvalGuard.filterTool(instance, approvals),
                },
            }),
        );
        this.#todos = channel(
            "todos",
            async (instance) => (await clients.todo.get(instance)).todo,
            (state, instance, todo) => ({
                ...state,
                todos: { ...state.todos, [instance]: todo },
            }),
        );
        this.#toolCalls = channel(
            "toolCalls",
            (instance) => clients.tool.listCalls(instance, { limit: 200 }),
            (state, instance, calls) => ({
                ...state,
                toolCalls: { ...state.toolCalls, [instance]: calls },
            }),
        );
        this.#contextMessages = channel(
            "contextMessages",
            (instance) => clients.contextMessage.list(instance),
            (state, instance, messages) => ({
                ...state,
                contextMessages: {
                    ...state.contextMessages,
                    [instance]: mergeContextMessageList(
                        state.contextMessages[instance] ?? [],
                        messages,
                    ),
                },
            }),
        );
        this.#channels = [
            this.#snapshot,
            this.#logs,
            this.#approvals,
            this.#todos,
            this.#toolCalls,
            this.#contextMessages,
        ] as readonly InstanceReadModelChannel<unknown>[];
    }

    async loadInitial(names: readonly string[]): Promise<InitialInstanceReadModels> {
        const result: InitialInstanceReadModels = {
            approvals: {},
            contextMessages: {},
            failures: {},
            logs: {},
            todos: {},
            toolCalls: {},
        };
        await Promise.all(names.map(async (instance) => {
            const [logs, approvals, todos, toolCalls, contextMessages] = await Promise.all([
                this.#logs.load(instance),
                this.#approvals.load(instance),
                this.#todos.load(instance),
                this.#toolCalls.load(instance),
                this.#contextMessages.load(instance),
            ]);
            this.assignInitial(result, instance, "logs", logs);
            this.assignInitial(result, instance, "approvals", approvals);
            this.assignInitial(result, instance, "todos", todos);
            this.assignInitial(result, instance, "toolCalls", toolCalls);
            this.assignInitial(result, instance, "contextMessages", contextMessages);
        }));
        return result;
    }

    async refreshAll(instance: string, generation: number): Promise<void> {
        await Promise.all(this.#channels.map((channel) =>
            channel.refresh(instance, generation)
        ));
    }

    applyAuthoritativeSnapshot(instance: string, snapshot: InstanceSnapshot): void {
        this.#snapshot.invalidate(instance);
        this.#authoritativeSnapshots.set(instance, snapshot);
        this.access.setState(this.applySnapshot(
            this.access.getState(),
            instance,
            snapshot,
            true,
        ));
    }

    recordToolDecision(instance: string, approvalId: string): void {
        this.approvalGuard.recordTool(instance, approvalId);
        this.#approvals.invalidate(instance);
        const state = this.access.getState();
        this.access.setState({
            ...state,
            approvals: {
                ...state.approvals,
                [instance]: (state.approvals[instance] ?? []).filter(
                    (approval) => approval.approvalId !== approvalId,
                ),
            },
        });
    }

    mergeQueuedContextMessage(instance: string, message: ContextMessageRecord): void {
        this.#contextMessages.invalidate(instance);
        const state = this.access.getState();
        this.access.setState({
            ...state,
            contextMessages: {
                ...state.contextMessages,
                [instance]: mergeContextMessage(
                    state.contextMessages[instance] ?? [],
                    message,
                ),
            },
            partialFailures: withoutFailure(
                state.partialFailures,
                this.#contextMessages.failureKey(instance),
            ),
        });
    }

    async refreshAfterToolDecision(
        instance: string,
        generation: number,
    ): Promise<void> {
        await Promise.all([
            this.#approvals.refresh(instance, generation),
            this.#todos.refresh(instance, generation),
            this.#toolCalls.refresh(instance, generation),
        ]);
    }

    handleEvent(instance: string, event: InstanceEvent, generation: number): void {
        if (event.type.startsWith("instance.")) {
            this.#snapshot.schedule(instance, generation);
        }
        if (event.type === "log.appended") this.#logs.schedule(instance, generation);
        if (event.type.startsWith("approval.")) {
            void this.#approvals.refresh(instance, generation);
        }
        if (event.type.startsWith("todo.")) this.#todos.schedule(instance, generation);
        if (event.type.startsWith("toolCall.")) {
            this.#toolCalls.schedule(instance, generation);
        }
        if (event.type.startsWith("context.message.")) {
            this.#contextMessages.schedule(instance, generation);
        }
    }

    reset(): void {
        for (const channel of this.#channels) channel.reset();
        this.#authoritativeSnapshots.clear();
    }

    private applySnapshot(
        state: WebState,
        instance: string,
        snapshot: InstanceSnapshot,
        authoritative = false,
    ): WebState {
        const fence = this.#authoritativeSnapshots.get(instance);
        if (!authoritative && fence !== undefined && snapshot.lastSeq < fence.lastSeq) {
            return state;
        }
        let resolved = snapshot;
        if (!authoritative && fence !== undefined && snapshot.lastSeq === fence.lastSeq) {
            resolved = {
                ...snapshot,
                connectionState: fence.connectionState,
                daemonState: fence.daemonState,
                lastSeq: fence.lastSeq,
                ready: fence.ready,
                status: fence.status,
            };
        } else if (!authoritative && fence !== undefined) {
            this.#authoritativeSnapshots.delete(instance);
        }
        return {
            ...state,
            instances: state.instances.map((entry) =>
                entry.name === instance && resolved.lastSeq >= entry.snapshot.lastSeq
                    ? { ...entry, snapshot: resolved }
                    : entry,
            ),
        };
    }

    private assignInitial<TKey extends keyof Omit<InitialInstanceReadModels, "failures">>(
        result: InitialInstanceReadModels,
        instance: string,
        key: TKey,
        read: { failure?: string; value?: InitialInstanceReadModels[TKey][string] },
    ): void {
        const channel = this.channelFor(key);
        if (read.failure !== undefined) {
            result.failures[channel.failureKey(instance)] = read.failure;
        } else if (read.value !== undefined) {
            result[key][instance] = read.value;
        }
    }

    private channelFor(
        key: keyof Omit<InitialInstanceReadModels, "failures">,
    ): InstanceReadModelChannel<unknown> {
        switch (key) {
            case "logs": return this.#logs;
            case "approvals": return this.#approvals;
            case "todos": return this.#todos;
            case "toolCalls": return this.#toolCalls;
            case "contextMessages": return this.#contextMessages;
        }
    }
}

function withoutFailure(
    failures: Record<string, string>,
    key: string,
): Record<string, string> {
    const { [key]: _removed, ...remaining } = failures;
    return remaining;
}
