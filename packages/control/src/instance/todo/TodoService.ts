import type {
    ActiveTodoSummary,
    InstanceEventType,
    JsonValue,
    TodoReadResult,
    TodoWriteInput,
    ToolCallAssociation
} from "@portable-devshell/shared";
import { randomUUID } from "node:crypto";

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

    async read(title?: string): Promise<TodoReadResult> {
        await this.#operation;
        return this.#readDocument(this.#store.read(), title);
    }

    summary(): ActiveTodoSummary | undefined {
        return this.#state.activeSummary(this.#store.read());
    }

    currentAssociation(ctxId?: string): ToolCallAssociation | undefined {
        return this.#state.currentAssociation(this.#store.read(), ctxId);
    }

    async addComment(text: string): Promise<void> {
        await this.#runExclusive(async () => {
            const document = this.#store.read();
            await this.#store.write({
                ...document,
                comments: [...document.comments, {
                    createdAt: new Date().toISOString(),
                    id: `comment-${randomUUID()}`,
                    text
                }]
            });
        });
    }

    async deleteComment(id: string): Promise<void> {
        await this.#runExclusive(async () => {
            const document = this.#store.read();
            await this.#store.write({
                ...document,
                comments: document.comments.filter((comment) => comment.id !== id)
            });
        });
    }

    async consumeComments(): Promise<string[]> {
        return await this.#runExclusive(async () => {
            const document = this.#store.read();
            await this.#store.write({ ...document, comments: [] });
            return document.comments.map((comment) => comment.text);
        });
    }

    async write(
        input: TodoWriteInput,
        ctxId: string
    ): Promise<TodoReadResult> {
        return await this.#runExclusive(async () => {
            const transition = this.#createTransition(input, ctxId);
            await this.#persistTransition(transition);
            await this.#emitTransition(transition);
            return this.#readDocument(transition.document, input.title);
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

    #readDocument(document: TodoDocument, title?: string): TodoReadResult {
        return this.#state.readResult(document, title);
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
