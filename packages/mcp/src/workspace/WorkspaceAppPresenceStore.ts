export interface WorkspaceAppPresenceStoreOptions {
    now?: () => number;
}

const WATCH_HANDOFF_GRACE_MS = 5_000;

interface WorkspaceAppPresenceState {
    lastSeenAt?: number;
    open: boolean;
    watches: number;
}

export class WorkspaceAppPresenceStore {
    readonly #now: () => number;
    readonly #states = new Map<string, WorkspaceAppPresenceState>();
    readonly #waiters = new Map<string, Set<() => void>>();

    constructor(options: WorkspaceAppPresenceStoreOptions = {}) {
        this.#now = options.now ?? Date.now;
    }

    open(instance: string, ctxId: string): void {
        const key = presenceKey(instance, ctxId);
        const existing = this.#states.get(key);
        this.#states.set(key, {
            ...(existing?.lastSeenAt === undefined ? {} : { lastSeenAt: existing.lastSeenAt }),
            open: true,
            watches: existing?.watches ?? 0,
        });
    }

    touch(instance: string, ctxId: string): void {
        const key = presenceKey(instance, ctxId);
        const existing = this.#states.get(key);
        this.#states.set(key, {
            lastSeenAt: this.#now(),
            open: true,
            watches: existing?.watches ?? 0,
        });
        this.#notify(key);
    }

    beginWatch(instance: string, ctxId: string): void {
        const key = presenceKey(instance, ctxId);
        const existing = this.#states.get(key);
        this.#states.set(key, {
            lastSeenAt: this.#now(),
            open: true,
            watches: (existing?.watches ?? 0) + 1,
        });
        this.#notify(key);
    }

    endWatch(instance: string, ctxId: string): void {
        const key = presenceKey(instance, ctxId);
        const existing = this.#states.get(key);
        if (existing === undefined) return;
        const watches = Math.max(0, existing.watches - 1);
        this.#states.set(key, {
            lastSeenAt: watches === 0 ? this.#now() : existing.lastSeenAt ?? this.#now(),
            open: existing.open,
            watches,
        });
    }

    has(instance: string, ctxId: string): boolean {
        return this.#states.has(presenceKey(instance, ctxId));
    }

    isActive(instance: string, ctxId: string, livenessMs: number): boolean {
        const state = this.#states.get(presenceKey(instance, ctxId));
        if (state?.lastSeenAt === undefined) return false;
        const effectiveLivenessMs = state.watches > 0
            ? livenessMs
            : Math.min(livenessMs, WATCH_HANDOFF_GRACE_MS);
        return this.#now() - state.lastSeenAt <= effectiveLivenessMs;
    }

    async waitUntilActive(
        instance: string,
        ctxId: string,
        livenessMs: number,
        timeoutMs: number,
    ): Promise<boolean> {
        if (this.isActive(instance, ctxId, livenessMs)) return true;
        if (timeoutMs <= 0) return false;
        const key = presenceKey(instance, ctxId);
        await new Promise<void>((resolve) => {
            const ready = () => {
                clearTimeout(timer);
                this.#waiters.get(key)?.delete(ready);
                resolve();
            };
            const timer = setTimeout(() => {
                this.#waiters.get(key)?.delete(ready);
                resolve();
            }, timeoutMs);
            const waiters = this.#waiters.get(key) ?? new Set<() => void>();
            waiters.add(ready);
            this.#waiters.set(key, waiters);
        });
        return this.isActive(instance, ctxId, livenessMs);
    }

    revokeContext(ctxId: string): void {
        this.#remove((key) => key.endsWith(`\0${ctxId}`));
    }

    revokeInstance(instance: string): void {
        this.#remove((key) => key.startsWith(`${instance}\0`));
    }

    #notify(key: string): void {
        const waiters = this.#waiters.get(key);
        if (waiters === undefined) return;
        this.#waiters.delete(key);
        for (const ready of waiters) ready();
    }

    #remove(matches: (key: string) => boolean): void {
        for (const key of [...this.#states.keys()]) {
            if (!matches(key)) continue;
            this.#states.delete(key);
            this.#notify(key);
        }
    }
}

function presenceKey(instance: string, ctxId: string): string {
    return `${instance}\0${ctxId}`;
}
