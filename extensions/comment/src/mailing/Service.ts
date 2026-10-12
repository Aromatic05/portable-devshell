import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type { ExtensionWorkerExecuteCapability } from "@portable-devshell/extension/worker";
import { mailMarker, parseOutbox, renderBounce, renderInbox, renderIndex, taskName } from "./Protocol.js";
import { WorkerMailingFiles, type MailingFiles } from "./Store.js";

interface MailingState {
    version: 1;
    claims: Record<string, string>;
    accepted: Record<string, string>;
}

export interface MailingTarget {
    instance: string;
    workspace: string;
}

export interface MailingClaim extends MailingTarget {
    ctxId: string;
}

export interface MailingPort {
    queue(instance: string, ctxId: string, subject: string): Promise<void>;
}

const ROOT = "var/agent-work";
const STATE_FILE = `${ROOT}/.mailing/state.json`;
const INDEX_FILE = `${ROOT}/mailing.md`;
const POLL_MS = 30_000;

function parseState(input: string | undefined): MailingState {
    if (input === undefined) return { version: 1, claims: {}, accepted: {} };
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid Mailing state");
    const state = parsed as Record<string, unknown>;
    if (state.version !== 1 || !isStringMap(state.claims) || !isStringMap(state.accepted))
        throw new Error("Unsupported or corrupt Mailing state");
    return { version: 1, claims: { ...state.claims }, accepted: { ...state.accepted } };
}

function isStringMap(value: unknown): value is Record<string, string> {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "string");
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
        // Only workspaces with a Mailing claim or an Outbox edit are monitored;
        // unrelated active Contexts incur no background Worker traffic.
        await Promise.all([...this.#scopes.values()].map(async (scope) => {
            try { await this.scan(scope); } catch (error) { this.#onError(error); }
        }));
    }

    async claim(input: MailingClaim, name: string): Promise<{ task: string; mailbox: string }> {
        const task = taskName(name);
        this.#remember(input);
        return await this.#exclusive(input, async (files) => {
            const active = await this.#activeContexts(input);
            if (!active.has(input.ctxId)) throw new Error("Claim requires an active Context bound to this Instance and Workspace");
            const state = parseState(await files.read(STATE_FILE));
            for (const [otherTask, owner] of Object.entries(state.claims)) {
                if (otherTask !== task && owner === input.ctxId)
                    throw new Error(`Context already claims ${otherTask}; release it before switching`);
            }
            const owner = state.claims[task];
            if (owner !== undefined && owner !== input.ctxId && active.has(owner))
                throw new Error(`Agent Work ${task} is already claimed by another active Context`);
            if (!(await files.listTasks()).includes(task))
                await files.create(`${ROOT}/${task}/INDEX.md`, `# ${task}\n`);
            state.claims[task] = input.ctxId;
            await this.#save(files, state);
            // Recover messages written before the receiving Context came online.
            await this.#dispatch(files, input, state, active);
            const mailbox = `${ROOT}/${task}/mailbox.md`;
            const oldMail = await files.read(mailbox);
            if (oldMail !== undefined && oldMail.trim().length > 0)
                await this.#notice(input, task, `Mailbox ready: ${mailbox}`);
            return { task, mailbox };
        });
    }

    async release(input: MailingClaim): Promise<{ released?: string }> {
        return await this.#exclusive(input, async (files) => {
            const state = parseState(await files.read(STATE_FILE));
            const task = Object.keys(state.claims).find((key) => state.claims[key] === input.ctxId);
            if (task === undefined) return {};
            delete state.claims[task];
            await this.#save(files, state);
            return { released: task };
        });
    }

    async status(input: MailingClaim): Promise<{ task?: string; mailbox?: string }> {
        return await this.#exclusive(input, async (files) => {
            const state = parseState(await files.read(STATE_FILE));
            const task = Object.keys(state.claims).find((key) => state.claims[key] === input.ctxId);
            return task === undefined ? {} : { task, mailbox: `${ROOT}/${task}/mailbox.md` };
        });
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
        let dirty = false;
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
                        continue;
                    }
                    await files.appendUnique(`${ROOT}/${recipient}/mailbox.md`, mailMarker(mail.id), renderInbox(mail));
                }
                state.accepted[mail.id] = mail.fingerprint;
                dirty = true;
                await this.#save(files, state);
                const senderCtx = state.claims[task];
                if (senderCtx !== undefined && active.has(senderCtx)) {
                    for (const recipient of recipients.filter((name) => !known.has(name))) {
                        await this.#notice({ ...scope, ctxId: senderCtx },
                            mail.id + ":bounce:" + recipient,
                            "New Mail\nFrom: mailer-daemon\nSubject: Undeliverable: " + mail.subject);
                    }
                }
                for (const recipient of recipients) {
                    if (!known.has(recipient)) continue;
                    const ctxId = state.claims[recipient];
                    if (ctxId === undefined || !active.has(ctxId)) continue;
                    await this.#notice({ ...scope, ctxId }, mail.id,
                        `New Mail\nFrom: ${mail.from}\nSubject: ${mail.subject}`);
                }
            }
        }
        if (dirty) await this.#save(files, state);
    }

    async #notice(input: MailingClaim, id: string, message: string): Promise<void> {
        const marker = `${input.ctxId}\0${id}`;
        if (this.#notified.has(marker)) return;
        this.#notified.add(marker);
        try { await this.#comment.queue(input.instance, input.ctxId, message); }
        catch (error) { this.#notified.delete(marker); this.#onError(error); }
    }
}
