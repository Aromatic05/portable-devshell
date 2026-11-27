import type { PiSessionLike } from "../runtime/Sdk.js";

import {
    PI_MAIN_AGENT_PATH,
    resolvePiAgentReference,
} from "./Namespace.js";

export type PiSubagentActivity = "idle" | "running";
export type PiSubagentLifecycle = "alive" | "terminated";
export type PiSubagentTurnOutcome = "completed" | "failed" | "interrupted";

export interface PiSubagentTurnSummary {
    readonly error?: string;
    readonly outcome: PiSubagentTurnOutcome;
    readonly result?: string;
}

export interface PiSubagentSnapshot {
    readonly activity: PiSubagentActivity;
    readonly agent: string;
    readonly id: string;
    readonly lastActivity?: string;
    readonly lastTurn?: PiSubagentTurnSummary;
    readonly lifecycle: PiSubagentLifecycle;
    readonly model?: string;
    readonly profile?: string;
    readonly task: string;
}

export interface PiSubagentEvent {
    readonly agent: string;
    readonly cursor: number;
    readonly detail?: string;
    readonly type:
        | "activity"
        | "completed"
        | "failed"
        | "input"
        | "interrupted"
        | "spawned"
        | "terminated";
}

export interface PiSubagentRecord {
    activity: PiSubagentActivity;
    readonly id: string;
    lastActivity?: string;
    lastTurn?: PiSubagentTurnSummary;
    lifecycle: PiSubagentLifecycle;
    model?: string;
    readonly name: string;
    readonly path: string;
    readonly profile?: string;
    session: PiSessionLike;
    task: string;
    turnGeneration: number;
    unsubscribe?: () => void;
}

interface EventWaiter {
    readonly after: number;
    readonly paths: ReadonlySet<string>;
    resolve(): void;
}

const MAX_EVENTS = 512;

export class PiAgentRegistry {
    readonly #events: PiSubagentEvent[] = [];
    readonly #records = new Map<string, PiSubagentRecord>();
    readonly #waiters = new Set<EventWaiter>();
    #cursor = 0;

    get cursor(): number {
        return this.#cursor;
    }

    add(record: PiSubagentRecord): void {
        if (this.#records.has(record.path))
            throw new Error(`Agent already exists: ${record.path}.`);
        this.#records.set(record.path, record);
        this.emit(record.path, "spawned", record.task);
    }

    has(path: string): boolean {
        return this.#records.has(path);
    }

    require(reference: string): PiSubagentRecord {
        const path = resolvePiAgentReference(reference);
        if (path === PI_MAIN_AGENT_PATH)
            throw new Error("/root/main cannot be managed as a subagent.");
        const record = this.#records.get(path);
        if (record === undefined) throw new Error(`Unknown Agent: ${path}.`);
        return record;
    }

    records(): PiSubagentRecord[] {
        return [...this.#records.values()];
    }

    paths(): string[] {
        return [...this.#records.keys()].sort();
    }

    snapshots(paths?: ReadonlySet<string>): PiSubagentSnapshot[] {
        return [...this.#records.values()]
            .filter((record) => paths === undefined || paths.has(record.path))
            .map(snapshot)
            .sort((left, right) => left.agent.localeCompare(right.agent));
    }

    eventsAfter(after: number, paths: ReadonlySet<string>): PiSubagentEvent[] {
        return this.#events.filter(
            (event) => event.cursor > after && paths.has(event.agent),
        );
    }

    emit(
        agent: string,
        type: PiSubagentEvent["type"],
        detail?: string,
    ): PiSubagentEvent {
        const event: PiSubagentEvent = {
            agent,
            cursor: ++this.#cursor,
            type,
            ...(detail === undefined ? {} : { detail }),
        };
        this.#events.push(event);
        if (this.#events.length > MAX_EVENTS)
            this.#events.splice(0, this.#events.length - MAX_EVENTS);
        for (const waiter of [...this.#waiters]) {
            if (event.cursor <= waiter.after || !waiter.paths.has(event.agent))
                continue;
            this.#waiters.delete(waiter);
            waiter.resolve();
        }
        return event;
    }

    async waitForEvent(
        after: number,
        paths: ReadonlySet<string>,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<boolean> {
        if (this.eventsAfter(after, paths).length > 0) return true;
        return await new Promise<boolean>((resolve, reject) => {
            let settled = false;
            const waiter: EventWaiter = {
                after,
                paths,
                resolve: () => finish(true),
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            timer.unref?.();
            const abort = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.#waiters.delete(waiter);
                reject(
                    signal?.reason instanceof Error
                        ? signal.reason
                        : new Error("Agent poll was aborted."),
                );
            };
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                this.#waiters.delete(waiter);
                resolve(value);
            };
            this.#waiters.add(waiter);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted === true) abort();
        });
    }
}

export function snapshot(record: PiSubagentRecord): PiSubagentSnapshot {
    return {
        activity: record.activity,
        agent: record.path,
        id: record.id,
        ...(record.lastActivity === undefined
            ? {}
            : { lastActivity: record.lastActivity }),
        ...(record.lastTurn === undefined ? {} : { lastTurn: record.lastTurn }),
        lifecycle: record.lifecycle,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.profile === undefined ? {} : { profile: record.profile }),
        task: record.task,
    };
}
