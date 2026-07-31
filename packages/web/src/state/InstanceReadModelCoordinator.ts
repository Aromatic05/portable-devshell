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
    instanceReadModelFailureKey,
    readInstanceModels,
    type InstanceReadModelKey,
    type InstanceReadModels,
} from "./InstanceReadModels.js";
import type { WebState } from "./WebState.js";

export interface InitialInstanceReadModels {
    approvals: Record<string, ApprovalRequest[]>;
    contextMessages: Record<string, ContextMessageRecord[]>;
    failures: Record<string, string>;
    logs: Record<string, InstanceLogEntry[]>;
    todos: Record<string, TodoReadResult>;
    toolCalls: Record<string, ToolCallRecord[]>;
}

export interface InstanceReadModelAccess {
    getState(): WebState;
    isCurrent(generation: number): boolean;
    setState(state: WebState): void;
}

const readModelKeys: readonly InstanceReadModelKey[] = [
    "instance",
    "logs",
    "approvals",
    "todos",
    "toolCalls",
    "contextMessages",
];

export class InstanceReadModelCoordinator {
    #logRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #todoRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #toolCallRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #contextMessageRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #readVersions = new Map<string, number>();

    constructor(
        private readonly clients: WebClients,
        private readonly access: InstanceReadModelAccess,
        private readonly approvalGuard: ApprovalDecisionGuard,
    ) {}

    async loadInitial(names: readonly string[]): Promise<InitialInstanceReadModels> {
        const result: InitialInstanceReadModels = {
            approvals: {},
            contextMessages: {},
            failures: {},
            logs: {},
            todos: {},
            toolCalls: {},
        };
        await Promise.all(names.map(async (name) => {
            const models = await readInstanceModels(this.clients, name);
            if (models.approvals !== undefined) {
                result.approvals[name] = this.approvalGuard.filterTool(
                    name,
                    models.approvals,
                );
            }
            if (models.contextMessages !== undefined) {
                result.contextMessages[name] = models.contextMessages;
            }
            if (models.logs !== undefined) result.logs[name] = models.logs;
            if (models.todo !== undefined) result.todos[name] = models.todo;
            if (models.toolCalls !== undefined) result.toolCalls[name] = models.toolCalls;
            for (const [key, failure] of Object.entries(models.failures)) {
                result.failures[instanceReadModelFailureKey(
                    key as InstanceReadModelKey,
                    name,
                )] = failure!;
            }
        }));
        return result;
    }

    async refreshAll(name: string, generation: number): Promise<void> {
        const versions = this.beginRead(name, true);
        const models = await readInstanceModels(this.clients, name, {
            includeSnapshot: true,
        });
        this.apply(name, models, versions, generation);
    }

    applyAuthoritativeSnapshot(name: string, snapshot: InstanceSnapshot): void {
        this.nextReadVersion(`instance:${name}`);
        const state = this.access.getState();
        this.access.setState({
            ...state,
            instances: state.instances.map((entry) =>
                entry.name === name && snapshot.lastSeq >= entry.snapshot.lastSeq
                    ? { ...entry, snapshot }
                    : entry,
            ),
        });
    }

    recordToolDecision(instance: string, approvalId: string): void {
        this.approvalGuard.recordTool(instance, approvalId);
        this.nextReadVersion(`approvals:${instance}`);
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
        this.nextReadVersion(`contextMessages:${instance}`);
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
                `contextMessages:${instance}`,
            ),
        });
    }

    async refreshAfterToolDecision(
        instance: string,
        generation: number,
    ): Promise<void> {
        await Promise.all([
            this.refreshApprovals(instance, generation),
            this.refreshTodo(instance, generation),
            this.refreshToolCalls(instance, generation),
        ]);
    }

    handleEvent(name: string, event: InstanceEvent, generation: number): void {
        if (event.type === "log.appended") this.scheduleLogRefresh(name, generation);
        if (event.type.startsWith("approval.")) {
            void this.refreshApprovals(name, generation);
        }
        if (event.type.startsWith("todo.")) this.scheduleTodoRefresh(name, generation);
        if (event.type.startsWith("toolCall.")) {
            this.scheduleToolCallRefresh(name, generation);
        }
        if (event.type.startsWith("context.message.")) {
            this.scheduleContextMessageRefresh(name, generation);
        }
    }

    clearScheduled(): void {
        clearTimers(this.#logRefreshes);
        clearTimers(this.#todoRefreshes);
        clearTimers(this.#toolCallRefreshes);
        clearTimers(this.#contextMessageRefreshes);
    }

    private scheduleLogRefresh(name: string, generation: number): void {
        this.schedule(this.#logRefreshes, name, () => this.readLogs(name, generation));
    }

    private scheduleTodoRefresh(name: string, generation: number): void {
        this.schedule(this.#todoRefreshes, name, () => this.refreshTodo(name, generation));
    }

    private scheduleToolCallRefresh(name: string, generation: number): void {
        this.schedule(
            this.#toolCallRefreshes,
            name,
            () => this.refreshToolCalls(name, generation),
        );
    }

    private scheduleContextMessageRefresh(name: string, generation: number): void {
        this.schedule(
            this.#contextMessageRefreshes,
            name,
            () => this.refreshContextMessages(name, generation),
        );
    }

    private schedule(
        timers: Map<string, ReturnType<typeof setTimeout>>,
        name: string,
        refresh: () => Promise<void>,
    ): void {
        if (timers.has(name)) return;
        const timeout = setTimeout(() => {
            timers.delete(name);
            void refresh();
        }, 250);
        timers.set(name, timeout);
    }

    private async readLogs(name: string, generation: number): Promise<void> {
        const key = `logs:${name}`;
        const version = this.nextReadVersion(key);
        try {
            const logs = await this.clients.runtime.readLogs(name, { limit: 100 });
            if (!this.isCurrent(key, version, generation)) return;
            const state = this.access.getState();
            this.access.setState({
                ...state,
                logs: { ...state.logs, [name]: logs.slice(-100) },
                partialFailures: withoutFailure(state.partialFailures, key),
            });
        } catch (error) {
            this.applyFailure(key, version, generation, error);
        }
    }

    private async refreshTodo(name: string, generation: number): Promise<void> {
        const key = `todos:${name}`;
        const version = this.nextReadVersion(key);
        try {
            const { todo } = await this.clients.todo.get(name);
            if (!this.isCurrent(key, version, generation)) return;
            const state = this.access.getState();
            this.access.setState({
                ...state,
                todos: { ...state.todos, [name]: todo },
                partialFailures: withoutFailure(state.partialFailures, key),
            });
        } catch (error) {
            this.applyFailure(key, version, generation, error);
        }
    }

    private async refreshApprovals(name: string, generation: number): Promise<void> {
        const key = `approvals:${name}`;
        const version = this.nextReadVersion(key);
        try {
            const approvals = await this.clients.tool.listApprovals(name);
            if (!this.isCurrent(key, version, generation)) return;
            const state = this.access.getState();
            this.access.setState({
                ...state,
                approvals: {
                    ...state.approvals,
                    [name]: this.approvalGuard.filterTool(name, approvals),
                },
                partialFailures: withoutFailure(state.partialFailures, key),
            });
        } catch (error) {
            this.applyFailure(key, version, generation, error);
        }
    }

    private async refreshToolCalls(name: string, generation: number): Promise<void> {
        const key = `toolCalls:${name}`;
        const version = this.nextReadVersion(key);
        try {
            const calls = await this.clients.tool.listCalls(name, { limit: 200 });
            if (!this.isCurrent(key, version, generation)) return;
            const state = this.access.getState();
            this.access.setState({
                ...state,
                toolCalls: { ...state.toolCalls, [name]: calls },
                partialFailures: withoutFailure(state.partialFailures, key),
            });
        } catch (error) {
            this.applyFailure(key, version, generation, error);
        }
    }

    private async refreshContextMessages(
        name: string,
        generation: number,
    ): Promise<void> {
        const key = `contextMessages:${name}`;
        const version = this.nextReadVersion(key);
        try {
            const messages = await this.clients.contextMessage.list(name);
            if (!this.isCurrent(key, version, generation)) return;
            const state = this.access.getState();
            this.access.setState({
                ...state,
                contextMessages: {
                    ...state.contextMessages,
                    [name]: mergeContextMessageList(
                        state.contextMessages[name] ?? [],
                        messages,
                    ),
                },
                partialFailures: withoutFailure(state.partialFailures, key),
            });
        } catch (error) {
            this.applyFailure(key, version, generation, error);
        }
    }

    private beginRead(
        name: string,
        includeSnapshot: boolean,
    ): Partial<Record<InstanceReadModelKey, number>> {
        const versions: Partial<Record<InstanceReadModelKey, number>> = {};
        for (const key of readModelKeys) {
            if (key === "instance" && !includeSnapshot) continue;
            versions[key] = this.nextReadVersion(instanceReadModelFailureKey(key, name));
        }
        return versions;
    }

    private apply(
        name: string,
        models: InstanceReadModels,
        versions: Partial<Record<InstanceReadModelKey, number>>,
        generation: number,
    ): void {
        if (!this.access.isCurrent(generation)) return;
        let next = this.access.getState();
        const failures = { ...next.partialFailures };
        const current = (key: InstanceReadModelKey): boolean => {
            const version = versions[key];
            return version !== undefined && this.isCurrent(
                instanceReadModelFailureKey(key, name),
                version,
                generation,
            );
        };
        const reconcileFailure = (key: InstanceReadModelKey): void => {
            if (!current(key)) return;
            const failureKey = instanceReadModelFailureKey(key, name);
            const failure = models.failures[key];
            if (failure === undefined) delete failures[failureKey];
            else failures[failureKey] = failure;
        };

        if (models.snapshot !== undefined && current("instance")) {
            next = {
                ...next,
                instances: next.instances.map((entry) =>
                    entry.name === name && models.snapshot!.lastSeq >= entry.snapshot.lastSeq
                        ? { ...entry, snapshot: models.snapshot! }
                        : entry,
                ),
            };
        }
        if (models.logs !== undefined && current("logs")) {
            next = { ...next, logs: { ...next.logs, [name]: models.logs } };
        }
        if (models.approvals !== undefined && current("approvals")) {
            next = {
                ...next,
                approvals: {
                    ...next.approvals,
                    [name]: this.approvalGuard.filterTool(name, models.approvals),
                },
            };
        }
        if (models.todo !== undefined && current("todos")) {
            next = { ...next, todos: { ...next.todos, [name]: models.todo } };
        }
        if (models.toolCalls !== undefined && current("toolCalls")) {
            next = {
                ...next,
                toolCalls: { ...next.toolCalls, [name]: models.toolCalls },
            };
        }
        if (models.contextMessages !== undefined && current("contextMessages")) {
            next = {
                ...next,
                contextMessages: {
                    ...next.contextMessages,
                    [name]: mergeContextMessageList(
                        next.contextMessages[name] ?? [],
                        models.contextMessages,
                    ),
                },
            };
        }
        for (const key of readModelKeys) reconcileFailure(key);
        this.access.setState({ ...next, partialFailures: failures });
    }

    private applyFailure(
        key: string,
        version: number,
        generation: number,
        error: unknown,
    ): void {
        if (!this.isCurrent(key, version, generation)) return;
        const state = this.access.getState();
        this.access.setState({
            ...state,
            partialFailures: {
                ...state.partialFailures,
                [key]: errorMessage(error),
            },
        });
    }

    private nextReadVersion(key: string): number {
        const version = (this.#readVersions.get(key) ?? 0) + 1;
        this.#readVersions.set(key, version);
        return version;
    }

    private isCurrent(key: string, version: number, generation: number): boolean {
        return this.access.isCurrent(generation) && this.#readVersions.get(key) === version;
    }
}

function clearTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
    for (const timeout of timers.values()) clearTimeout(timeout);
    timers.clear();
}

function withoutFailure(
    failures: Record<string, string>,
    key: string,
): Record<string, string> {
    const { [key]: _removed, ...remaining } = failures;
    return remaining;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
