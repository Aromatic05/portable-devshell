import { randomBytes } from "node:crypto";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type { ExtensionWorkerExecuteCapability } from "@portable-devshell/extension/worker";
import { mailMarker, parseOutbox, renderBounce, renderInbox, renderIndex, taskName, type Mail } from "./Protocol.js";
import { WorkerMailingFiles, type MailingFiles } from "./Store.js";

interface MailingState {
    version: 3;
    bindings: Record<string, string>;
    accepted: Record<string, string>;
    pendingNotices: Record<string, MailingNotice>;
    deliveries: Record<string, MailingDelivery>;
    notified: Record<string, string>;
}

interface MailingNotice {
    recipient: string;
    text: string;
    /** Once admission starts, retries must use the same causal notification. */
    identity?: MailingNotificationIdentity;
}

interface MailingDelivery {
    mail: Mail;
    recipients: string[];
    known: string[];
}

export interface MailingNotificationIdentity {
    instance: string;
    workspace: string;
    ctxId: string;
    mailId: string;
    kind: string;
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
    /** The identity and Comment insert must commit atomically in SQLite. */
    queue(instance: string, ctxId: string, subject: string, identity: MailingNotificationIdentity): Promise<void>;
}

const ROOT = "var/agent-work";
const STATE_FILE = `${ROOT}/.mailing/state.json`;
const INDEX_FILE = `${ROOT}/mailing.md`;
const POLL_MS = 30_000;

function parseState(input: string | undefined): MailingState {
    if (input === undefined) return { version: 3, bindings: {}, accepted: {}, pendingNotices: {}, deliveries: {}, notified: {} };
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
        return { version: 3, bindings: { ...state.claims }, accepted: { ...state.accepted }, pendingNotices: { ...pendingNotices }, deliveries: {}, notified: {} };
    if (state.version === 2 && isStringMap(state.bindings))
        return { version: 3, bindings: { ...state.bindings }, accepted: { ...state.accepted }, pendingNotices: { ...pendingNotices }, deliveries: {}, notified: {} };
    if (state.version === 3 && isStringMap(state.bindings) && isStringMap(state.notified) && isDeliveryMap(state.deliveries))
        return { version: 3, bindings: { ...state.bindings }, accepted: { ...state.accepted }, pendingNotices: { ...pendingNotices }, deliveries: { ...state.deliveries }, notified: { ...state.notified } };
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
            typeof (entry as MailingNotice).text === "string" &&
            ((entry as MailingNotice).identity === undefined || isNotificationIdentity((entry as MailingNotice).identity)));
}

function isNotificationIdentity(value: unknown): value is MailingNotificationIdentity {
    return isStringMap(value) && ["instance", "workspace", "ctxId", "mailId", "kind"].every((key) =>
        typeof value[key] === "string");
}

function isDeliveryMap(value: unknown): value is Record<string, MailingDelivery> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(value).every(([id, entry]) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
        const delivery = entry as MailingDelivery;
        const mail = delivery.mail;
        return mail !== null && typeof mail === "object" && mail.id === id &&
            typeof mail.from === "string" && typeof mail.subject === "string" &&
            typeof mail.body === "string" && typeof mail.fingerprint === "string" &&
            (mail.inReplyTo === undefined || typeof mail.inReplyTo === "string") &&
            Array.isArray(mail.to) && mail.to.every((name) => typeof name === "string") &&
            Array.isArray(delivery.recipients) && delivery.recipients.every((name) => typeof name === "string") &&
            Array.isArray(delivery.known) && delivery.known.every((name) => typeof name === "string");
    });
}

export class MailingService {
    readonly #worker: ExtensionWorkerExecuteCapability;
    readonly #contexts: ExtensionContextObserveCapability;
    readonly #comment: MailingPort;
    readonly #onError: (error: unknown) => void;
    readonly #locks = new Map<string, Promise<void>>();
    readonly #scopes = new Map<string, MailingTarget>();
    readonly #autoChecked = new Map<string, MemorySelection>();
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
        this.#autoChecked.clear();
    }

    async retireInstance(instance: string): Promise<void> {
        for (const [key, scope] of this.#scopes) {
            if (scope.instance === instance) this.#scopes.delete(key);
        }
        for (const key of this.#autoChecked.keys()) {
            if (key.startsWith(`${instance}\0`)) this.#autoChecked.delete(key);
        }
    }

    async retireContext(ctxId: string): Promise<void> {
        // Keep durable acknowledgements but discard the non-authoritative cache.
        for (const key of this.#autoChecked.keys()) {
            if (key.endsWith(`\0${ctxId}`)) this.#autoChecked.delete(key);
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

    /** First normal MCP ToolCall after environ_info: bind one persistent Memory
     * when the agent has not explicitly initialized or inherited one.
     */
    async ensureBound(input: MemoryContext): Promise<MemorySelection> {
        const key = `${input.instance}\0${input.workspace}\0${input.ctxId}`;
        const cached = this.#autoChecked.get(key);
        if (cached !== undefined) return cached;
        return await this.#exclusive(input, async (files) => {
            const state = parseState(await files.read(STATE_FILE));
            const existing = Object.keys(state.bindings).find((name) => state.bindings[name] === input.ctxId);
            if (existing !== undefined) {
                const selected = this.#selection(input, existing);
                this.#autoChecked.set(key, selected);
                this.#remember(input);
                return selected;
            }
            const active = await this.#activeContexts(input);
            if (!active.has(input.ctxId)) throw new Error("Automatic Memory binding requires an active Context");
            const names = new Set(await files.listTasks());
            let name: string;
            do { name = `auto-${randomBytes(6).toString("hex")}`; } while (names.has(name));
            await files.create(`${ROOT}/${name}/INDEX.md`, `# ${name}\n`);
            state.bindings[name] = input.ctxId;
            await this.#save(files, state);
            const selected = this.#selection(input, name);
            this.#autoChecked.set(key, selected);
            this.#remember(input);
            await this.#dispatch(files, input, state, active);
            return selected;
        });
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
            // Invalidate before any write: an interrupted Worker response can
            // leave a committed binding even if the rest of dispatch fails.
            this.#invalidateCachedScope(input);
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
            if (oldMail !== undefined && oldMail.trim().length > 0) {
                // dispatch may have advanced the durable journal; do not overwrite it.
                const current = parseState(await files.read(STATE_FILE));
                current.pendingNotices[`${name}:ready:${input.ctxId}`] = {
                    recipient: name, text: `Mailbox ready: ${selected.mailbox}`,
                    identity: { instance: input.instance, workspace: input.workspace, ctxId: input.ctxId,
                        mailId: name, kind: `ready:${input.ctxId}` },
                };
                await this.#save(files, current);
                await this.#flushNotices(files, input, current, active);
            }
            this.#autoChecked.set(`${input.instance}\0${input.workspace}\0${input.ctxId}`, selected);
            return selected;
        });
    }

    async release(input: MemoryContext): Promise<{ released?: string }> {
        return await this.#exclusive(input, async (files) => {
            const state = parseState(await files.read(STATE_FILE));
            const task = Object.keys(state.bindings).find((key) => state.bindings[key] === input.ctxId);
            this.#invalidateCachedScope(input);
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

    #invalidateCachedScope(input: MailingTarget): void {
        const prefix = `${this.#key(input)}\0`;
        for (const key of this.#autoChecked.keys()) {
            if (key.startsWith(prefix)) this.#autoChecked.delete(key);
        }
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

    async #dispatch(files: MailingFiles, scope: MailingTarget, initial: MailingState, active: Set<string>): Promise<void> {
        let state = initial;
        const failures: unknown[] = [];
        const attempted = new Set<string>();
        const deliver = async (delivery: MailingDelivery): Promise<void> => {
            attempted.add(delivery.mail.id);
            try {
                await this.#deliver(files, state, delivery);
            } catch (error) {
                failures.push(error);
                // A Worker response can be lost after its write committed. Only
                // reloaded state may authorize further delivery or notification.
                state = parseState(await files.read(STATE_FILE));
            }
        };
        // Recover the original publication before consulting mutable outboxes.
        for (const delivery of Object.values(state.deliveries)) await deliver(delivery);
        const tasks = await files.listTasks();
        for (const task of await files.listOutboxes()) {
            let messages: Mail[];
            try {
                const outbox = await files.read(`${ROOT}/${task}/chat.md`);
                if (outbox === undefined) continue;
                messages = parseOutbox(outbox, task, (error) =>
                    this.#onError(new Error("Invalid Mailing Outbox for " + task, { cause: error })));
            } catch (error) {
                this.#onError(new Error("Invalid Mailing Outbox for " + task, { cause: error }));
                continue;
            }
            for (const mail of messages) {
                const published = state.accepted[mail.id] ?? state.deliveries[mail.id]?.mail.fingerprint;
                if (published !== undefined) {
                    if (published !== mail.fingerprint)
                        failures.push(new Error(`Mail ${mail.id} changed after publication; Outbox is append-only`));
                    continue;
                }
                if (attempted.has(mail.id)) continue;
                const delivery: MailingDelivery = {
                    mail,
                    recipients: mail.to.includes("*") ? tasks.filter((name) => name !== task) : [...mail.to],
                    known: tasks,
                };
                state.deliveries[mail.id] = delivery;
                try {
                    // Journal the exact payload and recipient resolution before
                    // the first Markdown write. Replay never depends on outbox edits.
                    await this.#save(files, state);
                } catch (error) {
                    failures.push(error);
                    state = parseState(await files.read(STATE_FILE));
                    continue;
                }
                await deliver(delivery);
            }
        }
        try { await this.#flushNotices(files, scope, state, active); }
        catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Mailing reconciliation failures");
    }

    async #deliver(files: MailingFiles, state: MailingState, delivery: MailingDelivery): Promise<void> {
        const { mail, recipients, known } = delivery;
        await files.appendUnique(INDEX_FILE, mailMarker(mail.id), renderIndex(mail, recipients));
        for (const recipient of recipients) {
            const bounce = !known.includes(recipient);
            const id = `${mail.id}:${bounce ? "bounce" : "inbox"}:${recipient}`;
            await files.appendUnique(`${ROOT}/${bounce ? mail.from : recipient}/mailbox.md`,
                mailMarker(bounce ? `${mail.id}:bounce:${recipient}` : mail.id),
                bounce ? renderBounce(mail, recipient) : renderInbox(mail));
            state.pendingNotices[id] = {
                recipient: bounce ? mail.from : recipient,
                text: bounce
                    ? `New Mail\nFrom: mailer-daemon\nSubject: Undeliverable: ${mail.subject}`
                    : `New Mail\nFrom: ${mail.from}\nSubject: ${mail.subject}`,
            };
        }
        state.accepted[mail.id] = mail.fingerprint;
        delete state.deliveries[mail.id];
        await this.#save(files, state);
    }

    async #flushNotices(files: MailingFiles, scope: MailingTarget, initial: MailingState, active: Set<string>): Promise<void> {
        let state = initial;
        const failures: unknown[] = [];
        for (const id of Object.keys(state.pendingNotices)) {
            const notice = state.pendingNotices[id];
            if (notice === undefined) continue;
            const ctxId = notice.identity?.ctxId ?? state.bindings[notice.recipient];
            if (ctxId === undefined || (notice.identity === undefined && !active.has(ctxId))) continue;
            const [mailId, ...kind] = id.split(":");
            const identity: MailingNotificationIdentity = notice.identity ?? {
                instance: scope.instance, workspace: scope.workspace, ctxId, mailId: mailId!, kind: kind.join(":"),
            };
            if (identity.instance !== scope.instance || identity.workspace !== scope.workspace) continue;
            const key = JSON.stringify([identity.instance, identity.workspace, ctxId, identity.mailId, identity.kind]);
            try {
                if (state.notified[key] !== undefined && state.notified[key] !== notice.text)
                    throw new Error(`Mailing notification changed after publication: ${id}`);
                if (state.notified[key] === undefined) {
                    // Pin the recipient before admission. A lost admission response
                    // must not retarget the same causal attempt after inheritance.
                    if (notice.identity === undefined) {
                        notice.identity = identity;
                        await this.#save(files, state);
                    }
                    try {
                        await this.#comment.queue(scope.instance, ctxId, notice.text, identity);
                    } catch (error) {
                        this.#onError(error);
                        continue;
                    }
                    state.notified[key] = notice.text;
                }
                delete state.pendingNotices[id];
                await this.#save(files, state);
            } catch (error) {
                failures.push(error);
                state = parseState(await files.read(STATE_FILE));
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Mailing acknowledgement failures");
    }
}
