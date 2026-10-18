import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type { ExtensionWorkerExecuteCapability } from "@portable-devshell/extension/worker";
import { mailMarker, parseOutbox, renderBounce, renderInbox, renderIndex, taskName } from "./Protocol.js";
import { WorkerMailingFiles, type MailingFiles } from "./Store.js";

interface MailingState {
    version: 2;
    bindings: Record<string, string>;
    accepted: Record<string, string>;
    pendingNotices: Record<string, MailingNotice>;
}

interface MailingNotice {
    recipient: string;
    text: string;
}

export interface MailingTarget {
    /** Direct Memory calls have a parent Context; background scans do not. */
    ctxId?: string;
    instance: string;
    workspace: string;
}

export interface MemoryContext extends MailingTarget {
    ctxId: string;
}

export interface MemorySelection {
    name: string;
    directory: string;
    mailbox: string;
}

export interface MailingPort {
    queue(instance: string, ctxId: string, subject: string): Promise<void>;
}

const ROOT = "var/agent-work";
const STATE_FILE = `${ROOT}/.mailing/state.json`;
const INDEX_FILE = `${ROOT}/mailing.md`;
const POLL_MS = 30_000;

function parseState(input: string | undefined): MailingState {
    if (input === undefined) return { version: 2, bindings: {}, accepted: {}, pendingNotices: {} };
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid Mailing state");
    const state = parsed as Record<string, unknown>;
    if (!isStringMap(state.accepted)) throw new Error("Unsupported or corrupt Mailing state");
    const pendingNotices = state.pendingNotices ?? {};
    if (!isNoticeMap(pendingNotices)) throw new Error("Invalid Mailing pending notices");
    // The original Mailing claims were already the persisted Context -> directory
    // relation. Reuse them as Memory bindings without losing accepted mail IDs.
    if (state.version === 1 && isStringMap(state.claims))
        return { version: 2, bindings: { ...state.claims }, accepted: { ...state.accepted }, pendingNotices: { ...pendingNotices } };
    if (state.version === 2 && isStringMap(state.bindings))
        return { version: 2, bindings: { ...state.bindings }, accepted: { ...state.accepted }, pendingNotices: { ...pendingNotices } };
    throw new Error("Unsupported or corrupt Mailing state");
}

function isStringMap(value: unknown): value is Record<string, string> {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "string");
}

function isNoticeMap(value: unknown): value is Record<string, MailingNotice> {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        Object.values(value).every((entry) =>
            entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
            typeof (entry as MailingNotice).recipient === "string" &&
            typeof (entry as MailingNotice).text === "string");
}

export class MailingService {
    readonly #worker: ExtensionWorkerExecuteCapability;
    readonly #contexts: ExtensionContextObserveCapability;
    readonly #comment: MailingPort;
    readonly #onError: (error: unknown) => void;
    readonly #locks = new Map<string, Promise<void>>();
    readonly #scopes = new Map<string, MailingTarget>();
    readonly #notified = new Set<string>();
    readonly #timer: ReturnType<typeof setInterval>;
    #closed = false;

    constructor(options: {
        worker: ExtensionWorkerExecuteCapability;
        contexts: ExtensionContextObserveCapability;
        comment: MailingPort;
        onError(error: unknown): void;
        pollMs?: number;
    }) {
        this.#worker = options.worker;
        this.#contexts = options.contexts;
        this.#comment = options.comment;
        this.#onError = options.onError;
        this.#timer = setInterval(() => {
            void this.poll().catch(this.#onError);
        }, options.pollMs ?? POLL_MS);
        this.#timer.unref?.();
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        clearInterval(this.#timer);
        await Promise.allSettled([...this.#locks.values()]);
        this.#scopes.clear();
        this.#notified.clear();
    }

    async retireInstance(instance: string): Promise<void> {
        for (const [key, scope] of this.#scopes) {
            if (scope.instance === instance) this.#scopes.delete(key);
        }
    }

    async retireContext(ctxId: string): Promise<void> {
        for (const marker of this.#notified) {
            if (marker.startsWith(`${ctxId}\0`)) this.#notified.delete(marker);
        }
    }

    async poll(): Promise<void> {
        if (this.#closed) return;
        // Context attachments persist across Control restarts, unlike #scopes.
        // Reconcile from the owning Context registry so shell-written mail can
        // be discovered without a new memory status call or file_edit hook.
        try {
            const contexts = await this.#contexts.list({ status: "active" });
            for (const context of contexts) {
                for (const environment of context.environments) {
                    if (environment.workspace !== undefined)
                        this.#remember({ instance: environment.instance, workspace: environment.workspace });
                }
            }
        } catch (error) {
            this.#onError(error);
        }
        await Promise.all([...this.#scopes.values()].map(async (scope) => {
            try { await this.scan(scope); } catch (error) { this.#onError(error); }
        }));
    }

    async init(input: MemoryContext, name: string): Promise<MemorySelection> {
        return await this.#bind(input, taskName(name), "init");
    }

    async inherit(input: MemoryContext, name: string): Promise<MemorySelection> {
        return await this.#bind(input, taskName(name), "inherit");
    }

    async #bind(input: MemoryContext, name: string, mode: "init" | "inherit"): Promise<MemorySelection> {
        return await this.#exclusive(input, async (files) => {
            const active = await this.#activeContexts(input);
            if (!active.has(input.ctxId))
                throw new Error("Memory binding requires an active Context in this Instance and Workspace");
            const exists = (await files.listTasks()).includes(name);
            const state = parseState(await files.read(STATE_FILE));
            if (mode === "init" && exists && state.bindings[name] !== input.ctxId)
                throw new Error(`Memory ${name} already exists; use devshell memory inherit ${name}`);
            if (mode === "inherit" && !exists)
                throw new Error(`Memory ${name} does not exist; use devshell memory init ${name}`);
            if (!exists) await files.create(`${ROOT}/${name}/INDEX.md`, `# ${name}\n`);
            // A Context holds one Memory; inherit transfers the identity, even
            // when a prior Context is still active. No directory is copied.
            for (const [other, owner] of Object.entries(state.bindings)) {
                if (owner === input.ctxId) delete state.bindings[other];
            }
            state.bindings[name] = input.ctxId;
            await this.#save(files, state);
            this.#remember(input);
            await this.#dispatch(files, input, state, active);
            const selected = this.#selection(input, name);
            const oldMail = await files.read(`${ROOT}/${name}/mailbox.md`);
            if (oldMail !== undefined && oldMail.trim().length > 0)
                await this.#notice(input, name, `Mailbox ready: ${selected.mailbox}`);
            return selected;
        });
    }

    async release(input: MemoryContext): Promise<{ released?: string }> {
        return await this.#exclusive(input, async (files) => {
            const state = parseState(await files.read(STATE_FILE));
            const task = Object.keys(state.bindings).find((key) => state.bindings[key] === input.ctxId);
            if (task === undefined) return {};
            delete state.bindings[task];
            await this.#save(files, state);
            return { released: task };
        });
    }

    async status(input: MemoryContext): Promise<MemorySelection | Record<string, never>> {
        return await this.#exclusive(input, async (files) => {
            const state = parseState(await files.read(STATE_FILE));
            const name = Object.keys(state.bindings).find((key) => state.bindings[key] === input.ctxId);
            if (name === undefined) return {};
            // A status lookup after Control restart also resumes mail polling.
            this.#remember(input);
            return this.#selection(input, name);
        });
    }

    async list(input: MailingTarget): Promise<{ memories: string[] }> {
        if (this.#closed) throw new Error("Mailing Service is closed");
        const session = await this.#worker.openSession(input);
        try {
            return { memories: await new WorkerMailingFiles(session).listTasks() };
        } finally {
            await session.close();
        }
    }

    #selection(input: MailingTarget, name: string): MemorySelection {
        return {
            name,
            directory: `${input.workspace}/${ROOT}/${name}`,
            mailbox: `${input.workspace}/${ROOT}/${name}/mailbox.md`,
        };
    }

    async scan(scope: MailingTarget): Promise<void> {
        this.#remember(scope);
        await this.#exclusive(scope, async (files) => {
            const state = parseState(await files.read(STATE_FILE));
            const active = await this.#activeContexts(scope);
            await this.#dispatch(files, scope, state, active);
        });
    }

    #remember(input: MailingTarget): void {
        if (this.#closed) return;
        this.#scopes.set(this.#key(input), { instance: input.instance, workspace: input.workspace });
    }

    #key(input: MailingTarget): string {
        return `${input.instance}\0${input.workspace}`;
    }

    async #activeContexts(scope: MailingTarget): Promise<Set<string>> {
        const records = await this.#contexts.list({ instance: scope.instance, workspace: scope.workspace, status: "active" });
        return new Set(records.filter((record) =>
            record.environments.some((environment) =>
                environment.instance === scope.instance && environment.workspace === scope.workspace,
            )).map((record) => record.ctxId));
    }

    async #exclusive<T>(scope: MailingTarget, operation: (files: MailingFiles) => Promise<T>): Promise<T> {
        if (this.#closed) throw new Error("Mailing Service is closed");
        const key = this.#key(scope);
        const previous = this.#locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const wait = new Promise<void>((resolve) => { release = resolve; });
        const completion = previous.catch(() => undefined).then(() => wait);
        this.#locks.set(key, completion);
        await previous.catch(() => undefined);
        try {
            if (this.#closed) throw new Error("Mailing Service is closed");
            const session = await this.#worker.openSession(scope);
            const files = new WorkerMailingFiles(session);
            try { return await operation(files); } finally { await files.close(); }
        } finally {
            release();
            if (this.#locks.get(key) === completion) this.#locks.delete(key);
        }
    }

    async #save(files: MailingFiles, state: MailingState): Promise<void> {
        await files.replace(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    }

    async #dispatch(files: MailingFiles, scope: MailingTarget, state: MailingState, active: Set<string>): Promise<void> {
        const tasks = await files.listTasks();
        const known = new Set(tasks);
        for (const task of await files.listOutboxes()) {
            const outbox = await files.read(`${ROOT}/${task}/chat.md`);
            if (outbox === undefined || !outbox.includes("<!-- MAIL BEGIN -->")) continue;
            let messages;
            try {
                messages = parseOutbox(outbox, task);
            } catch (error) {
                this.#onError(new Error("Invalid Mailing Outbox for " + task, { cause: error }));
                continue; // One sender's malformed message cannot stall other mailboxes.
            }
            for (const mail of messages) {
                const accepted = state.accepted[mail.id];
                if (accepted !== undefined) {
                    if (accepted !== mail.fingerprint)
                        throw new Error(`Mail ${mail.id} changed after publication; Outbox is append-only`);
                    continue;
                }
                const recipients = mail.to.includes("*")
                    ? tasks.filter((name) => name !== task)
                    : mail.to;
                await files.appendUnique(INDEX_FILE, mailMarker(mail.id), renderIndex(mail, recipients));
                for (const recipient of recipients) {
                    if (!known.has(recipient)) {
                        await files.appendUnique(`${ROOT}/${task}/mailbox.md`,
                            mailMarker(`${mail.id}:bounce:${recipient}`), renderBounce(mail, recipient));
                        state.pendingNotices[`${mail.id}:bounce:${recipient}`] = {
                            recipient: task,
                            text: `New Mail\nFrom: mailer-daemon\nSubject: Undeliverable: ${mail.subject}`,
                        };
                        continue;
                    }
                    await files.appendUnique(`${ROOT}/${recipient}/mailbox.md`, mailMarker(mail.id), renderInbox(mail));
                    state.pendingNotices[`${mail.id}:inbox:${recipient}`] = {
                        recipient,
                        text: `New Mail\nFrom: ${mail.from}\nSubject: ${mail.subject}`,
                    };
                }
                state.accepted[mail.id] = mail.fingerprint;
                // Delivery and notification acknowledgements are separate:
                // retry pending Subjects even after the message is accepted.
                await this.#save(files, state);
            }
        }
        await this.#flushNotices(files, scope, state, active);
    }

    async #flushNotices(files: MailingFiles, scope: MailingTarget, state: MailingState, active: Set<string>): Promise<void> {
        for (const [id, notice] of Object.entries(state.pendingNotices)) {
            const ctxId = state.bindings[notice.recipient];
            if (ctxId === undefined || !active.has(ctxId)) continue;
            if (!(await this.#notice({ ...scope, ctxId }, id, notice.text))) continue;
            delete state.pendingNotices[id];
            try {
                await this.#save(files, state);
            } catch (error) {
                state.pendingNotices[id] = notice;
                throw error;
            }
        }
    }

    async #notice(input: MemoryContext, id: string, message: string): Promise<boolean> {
        const marker = `${input.ctxId}\0${id}`;
        if (this.#notified.has(marker)) return true;
        this.#notified.add(marker);
        try {
            await this.#comment.queue(input.instance, input.ctxId, message);
            return true;
        } catch (error) {
            this.#notified.delete(marker);
            this.#onError(error);
            return false;
        }
    }
}
