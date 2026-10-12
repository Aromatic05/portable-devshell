import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface McpAppQuestion {
    id: string;
    ctxId: string;
    instance: string;
    question: string;
    choices: string[];
    allowText: boolean;
    status: "pending" | "answered";
    answer?: string;
    createdAt: string;
}

interface QuestionDocument {
    version: 1;
    revision: number;
    questions: McpAppQuestion[];
}

/** A Context-owned question inbox. Pending questions survive cancelled calls and restarts. */
export class McpAppQuestionStore {
    readonly #filePath?: string;
    readonly #questions = new Map<string, McpAppQuestion>();
    readonly #waiters = new Map<string, Set<(answer: string) => void>>();
    readonly #changed = new Set<() => void>();
    #revision = 0;
    #initialized: boolean;
    #operation = Promise.resolve();

    constructor(filePath?: string) {
        this.#filePath = filePath;
        this.#initialized = filePath === undefined;
    }

    async initialize(): Promise<void> {
        await this.#run(async () => {
            if (this.#initialized) return;
            let text: string;
            try { text = await readFile(this.#filePath!, "utf8"); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                this.#initialized = true;
                return;
            }
            const document: unknown = JSON.parse(text);
            if (!validDocument(document)) throw new Error("Invalid MCP App question state.");
            this.#revision = document.revision;
            for (const question of document.questions) this.#questions.set(question.id, question);
            this.#initialized = true;
        });
    }

    get revision(): number { return this.#revision; }

    pending(instance: string, ctxId: string): McpAppQuestion[] {
        this.#assertReady();
        return [...this.#questions.values()].filter((q) =>
            q.instance === instance && q.ctxId === ctxId && q.status === "pending"
        ).map((q) => structuredClone(q));
    }

    async create(instance: string, ctxId: string, input: {
        question: string; choices?: string[]; allowText?: boolean;
    }): Promise<McpAppQuestion> {
        return await this.#run(async () => {
            this.#assertReady();
            if (this.pending(instance, ctxId).length > 0)
                throw new Error("A question is already pending in this Context.");
            const question: McpAppQuestion = {
                id: randomUUID(), instance, ctxId, question: input.question,
                choices: [...(input.choices ?? [])], allowText: input.allowText !== false,
                status: "pending", createdAt: new Date().toISOString(),
            };
            this.#questions.set(question.id, question);
            try { await this.#persistChange(); }
            catch (error) { this.#questions.delete(question.id); throw error; }
            return structuredClone(question);
        });
    }

    assertAnswer(instance: string, ctxId: string, id: string, answer: string): McpAppQuestion {
        const question = this.#questions.get(id);
        if (question?.instance !== instance || question.ctxId !== ctxId || question.status !== "pending")
            throw new Error("The question is unavailable in this Context.");
        if (!answer || answer.length > 4_000 ||
            (!question.allowText && !question.choices.includes(answer)))
            throw new Error("Invalid answer for this question.");
        return structuredClone(question);
    }

    async answer(instance: string, ctxId: string, id: string, answer: string): Promise<{ detached: boolean; question: McpAppQuestion }> {
        return await this.#run(async () => {
            const previous = this.assertAnswer(instance, ctxId, id, answer);
            const detached = (this.#waiters.get(id)?.size ?? 0) === 0;
            const next: McpAppQuestion = { ...previous, status: "answered", answer };
            this.#questions.set(id, next);
            try { await this.#persistChange(); }
            catch (error) { this.#questions.set(id, previous); throw error; }
            for (const listener of this.#waiters.get(id) ?? []) listener(answer);
            return { detached, question: structuredClone(next) };
        });
    }

    async wait(id: string, signal?: AbortSignal): Promise<string> {
        this.#assertReady();
        const question = this.#questions.get(id);
        if (question === undefined) throw new Error("Question no longer exists.");
        if (question.status === "answered") return question.answer!;
        if (signal?.aborted) throw new Error("Question tool call was cancelled.");
        return await new Promise<string>((resolve, reject) => {
            const finish = (answer: string) => { cleanup(); resolve(answer); };
            const abort = () => { cleanup(); reject(new Error("Question tool call was cancelled; answer remains available in MCP App.")); };
            const cleanup = () => {
                this.#waiters.get(id)?.delete(finish);
                if (this.#waiters.get(id)?.size === 0) this.#waiters.delete(id);
                signal?.removeEventListener("abort", abort);
            };
            const listeners = this.#waiters.get(id) ?? new Set<(answer: string) => void>();
            listeners.add(finish);
            this.#waiters.set(id, listeners);
            signal?.addEventListener("abort", abort, { once: true });
        });
    }

    async changedSince(revision: number, signal?: AbortSignal): Promise<boolean> {
        if (this.#revision !== revision) return true;
        if (signal?.aborted) return false;
        return await new Promise<boolean>((resolve) => {
            const done = (changed: boolean) => {
                this.#changed.delete(change);
                signal?.removeEventListener("abort", abort);
                resolve(changed);
            };
            const change = () => done(true);
            const abort = () => done(false);
            this.#changed.add(change);
            signal?.addEventListener("abort", abort, { once: true });
            if (this.#revision !== revision) done(true);
        });
    }

    async revokeContext(ctxId: string): Promise<void> { await this.#remove((q) => q.ctxId === ctxId); }
    async revokeInstance(instance: string): Promise<void> { await this.#remove((q) => q.instance === instance); }
    contextIds(): string[] { return [...new Set([...this.#questions.values()].map((q) => q.ctxId))]; }

    async #remove(matches: (q: McpAppQuestion) => boolean): Promise<void> {
        await this.#run(async () => {
            const removed = [...this.#questions].filter(([, q]) => matches(q));
            if (removed.length === 0) return;
            for (const [id] of removed) this.#questions.delete(id);
            try { await this.#persistChange(); }
            catch (error) { for (const [id, question] of removed) this.#questions.set(id, question); throw error; }
            for (const [id] of removed) for (const listener of this.#waiters.get(id) ?? []) listener("");
        });
    }

    async #persistChange(): Promise<void> {
        const revision = this.#revision + 1;
        if (this.#filePath !== undefined) {
            await mkdir(dirname(this.#filePath), { recursive: true });
            const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify({ version: 1, revision,
                questions: [...this.#questions.values()] } satisfies QuestionDocument, null, 2) + "\n", { mode: 0o600 });
            await rename(temporary, this.#filePath);
        }
        this.#revision = revision;
        for (const listener of [...this.#changed]) listener();
    }

    async #run<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;
        this.#operation = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await operation(); } finally { release(); }
    }
    #assertReady(): void { if (!this.#initialized) throw new Error("Question state is not initialized."); }
}

function validDocument(value: unknown): value is QuestionDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const doc = value as Partial<QuestionDocument>;
    return doc.version === 1 && Number.isSafeInteger(doc.revision) && (doc.revision ?? -1) >= 0 &&
        Array.isArray(doc.questions) && doc.questions.every((q) =>
            q && typeof q.id === "string" && typeof q.ctxId === "string" && typeof q.instance === "string" &&
            typeof q.question === "string" && Array.isArray(q.choices) && q.choices.every((c) => typeof c === "string") &&
            typeof q.allowText === "boolean" && (q.status === "pending" || q.status === "answered") &&
            (q.status === "pending" || typeof q.answer === "string") && typeof q.createdAt === "string");
}
