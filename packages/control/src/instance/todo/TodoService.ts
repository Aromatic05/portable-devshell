import type {
    ActiveTodoSummary,
    InstanceEventType,
    JsonValue,
    TodoReadInput,
    TodoReadResult,
    TodoTaskControlAction,
    TodoWriteInput,
    ToolCallAssociation
} from "@portable-devshell/shared";

import { TodoState, type TodoDocument, type TodoTransition } from "./TodoState.js";
import { TodoStore } from "./TodoStore.js";

export interface TodoServiceOptions {
    appendEvent(
        type: Extract<InstanceEventType, `todo.${string}`>,
        data: JsonValue
    ): Promise<void>;
    filePath: string;
    instanceName: string;
}

export class TodoService {
    readonly #appendEvent: TodoServiceOptions["appendEvent"];
    readonly #state: TodoState;
    readonly #store: TodoStore;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: TodoServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#state = new TodoState(options.instanceName);
        this.#store = new TodoStore({
            filePath: options.filePath,
            instanceName: options.instanceName,
            state: this.#state
        });
    }

    async read(input?: TodoReadInput | string): Promise<TodoReadResult> {
        await this.#operation;
        return this.#readDocument(input === undefined ? this.#store.readActive() : this.#store.read(), input);
    }

    summaries(): ActiveTodoSummary[] {
        return this.#state.activeSummaries(this.#store.readActive());
    }

    currentAssociation(ctxId?: string): ToolCallAssociation | undefined {
        return this.#state.currentAssociation(this.#store.readActive(), ctxId);
    }

    async write(
        input: TodoWriteInput,
        ctxId: string
    ): Promise<TodoReadResult> {
        return await this.#runExclusive(async () => {
            const committed = await this.#store.transition((document) => {
                const transition = this.#state.transition(document, input, ctxId);
                const { tasks: _tasks, ...result } = this.#readDocument(transition.document, {
                    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
                    title: input.title
                });
                return {
                    document: transition.document,
                    result: { events: transition.events, value: result }
                };
            });
            await this.#emitEvents(committed.events);
            return committed.value;
        });
    }

    async control(
        taskId: string,
        action: TodoTaskControlAction,
        ctxId: string,
        expectedRevision?: number,
    ): Promise<TodoReadResult> {
        return await this.#runExclusive(async () => {
            const committed = await this.#store.transition((document) => {
                const transition = this.#state.control(document, taskId, action, ctxId, expectedRevision);
                const { tasks: _tasks, ...result } = this.#readDocument(transition.document, { taskId });
                return {
                    document: transition.document,
                    result: { events: transition.events, value: result }
                };
            });
            await this.#emitEvents(committed.events);
            return committed.value;
        });
    }

    async cancelAll(): Promise<void> {
        await this.#runExclusive(async () => {
            for (const task of this.#store.readActive().active) {
                const events = await this.#store.transition((document) => {
                    const transition = this.#state.control(
                        document,
                        task.taskId,
                        "cancel",
                        task.activeCtxId ?? task.createdByCtxId,
                        task.revision,
                    );
                    return { document: transition.document, result: transition.events };
                });
                await this.#emitEvents(events);
            }
        });
    }

    async delete(taskId: string): Promise<void> {
        await this.#runExclusive(async () => {
            const events = await this.#store.transition((document) => {
                const transition = this.#state.delete(document, taskId);
                return { document: transition.document, result: transition.events };
            });
            await this.#emitEvents(events);
        });
    }

    async #emitEvents(events: TodoTransition["events"]): Promise<void> {
        for (const event of events) {
            await this.#appendEvent(event.type, event.data).catch(() => undefined);
        }
    }

    #readDocument(document: TodoDocument, input?: TodoReadInput | string): TodoReadResult {
        return this.#state.readResult(document, input);
    }

    async #runExclusive<T>(
        operation: () => Promise<T>
    ): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;

        this.#operation = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}
