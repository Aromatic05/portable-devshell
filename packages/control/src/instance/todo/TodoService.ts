import type {
    ActiveTodoSummary,
    InstanceEventType,
    JsonValue,
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

    async read(): Promise<TodoReadResult> {
        await this.#operation;
        return this.#readDocument(this.#store.read());
    }

    summary(): ActiveTodoSummary | undefined {
        return this.#state.activeSummary(this.#store.read());
    }

    currentAssociation(): ToolCallAssociation | undefined {
        return this.#state.currentAssociation(this.#store.read());
    }

    async write(
        input: TodoWriteInput,
        ctxId: string
    ): Promise<TodoReadResult> {
        return await this.#runExclusive(async () => {
            const transition = this.#createTransition(input, ctxId);
            await this.#persistTransition(transition);
            await this.#emitTransition(transition);
            return this.#readDocument(transition.document);
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
            await this.#appendEvent(event.type, event.data);
        }
    }

    #readDocument(document: TodoDocument): TodoReadResult {
        return this.#state.readResult(document);
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
