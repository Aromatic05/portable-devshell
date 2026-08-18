import type {
    ActiveTodoSummary,
    InstanceEventType,
    JsonValue,
    TodoReadInput,
    TodoReadResult,
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
        return this.#readDocument(this.#store.read(), input);
    }

    summaries(): ActiveTodoSummary[] {
        return this.#state.activeSummaries(this.#store.read());
    }

    currentAssociation(ctxId?: string): ToolCallAssociation | undefined {
        return this.#state.currentAssociation(this.#store.read(), ctxId);
    }

    async write(
        input: TodoWriteInput,
        ctxId: string
    ): Promise<TodoReadResult> {
        return await this.#runExclusive(async () => {
            const transition = this.#createTransition(input, ctxId);
            await this.#persistTransition(transition);
            await this.#emitTransition(transition);
            const { tasks: _tasks, ...result } = this.#readDocument(transition.document, {
                ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
                title: input.title
            });
            return result;
        });
    }

    async delete(taskId: string): Promise<void> {
        await this.#runExclusive(async () => {
            const transition = this.#state.delete(this.#store.read(), taskId);
            await this.#persistTransition(transition);
            await this.#emitTransition(transition);
        });
    }

    #createTransition(
        input: TodoWriteInput,
        ctxId: string
    ): TodoTransition {
        return this.#state.transition(
            this.#store.read(),
            input,
            ctxId
        );
    }

    async #persistTransition(transition: TodoTransition): Promise<void> {
        await this.#store.write(transition.document);
    }

    async #emitTransition(transition: TodoTransition): Promise<void> {
        for (const event of transition.events) {
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
