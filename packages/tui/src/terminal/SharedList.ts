import type { TerminalSessionDescriptor } from "@portable-devshell/shared";

export interface SharedTerminalSnapshot {
    instance?: string;
    active?: TerminalSessionDescriptor;
    sessions: readonly TerminalSessionDescriptor[];
    selectedIndex: number;
    loading: boolean;
    error?: string;
}

export class TuiSharedTerminalList {
    #snapshot: SharedTerminalSnapshot = {
        sessions: [],
        selectedIndex: 0,
        loading: false,
    };
    #revision = 0;
    readonly #listeners = new Set<() => void>();

    constructor(
        private readonly list: (
            instance: string,
        ) => Promise<TerminalSessionDescriptor[]>,
    ) {}

    getSnapshot(): SharedTerminalSnapshot {
        return this.#snapshot;
    }
    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
    async bind(instance?: string): Promise<void> {
        if (this.#snapshot.instance === instance) return;
        ++this.#revision;
        this.#update({
            instance,
            sessions: [],
            selectedIndex: 0,
            loading: false,
        });
        await this.refresh();
    }
    async refresh(): Promise<void> {
        const instance = this.#snapshot.instance;
        if (instance === undefined) return;
        const revision = ++this.#revision;
        const selected =
            this.#snapshot.sessions[this.#snapshot.selectedIndex]?.terminalId;
        this.#update({ ...this.#snapshot, loading: true, error: undefined });
        try {
            const sessions = (await this.list(instance)).filter(
                (session) => session.state === "running",
            );
            if (revision !== this.#revision) return;
            const index = sessions.findIndex(
                (session) => session.terminalId === selected,
            );
            this.#update({
                ...this.#snapshot,
                sessions,
                selectedIndex: Math.max(0, index),
                loading: false,
            });
        } catch (error) {
            if (revision !== this.#revision) return;
            this.#update({
                ...this.#snapshot,
                error: error instanceof Error ? error.message : String(error),
                loading: false,
            });
        }
    }
    move(delta: number): void {
        const selectedIndex = Math.max(
            0,
            Math.min(
                this.#snapshot.sessions.length - 1,
                this.#snapshot.selectedIndex + delta,
            ),
        );
        this.#update({ ...this.#snapshot, selectedIndex });
    }
    enter(): TerminalSessionDescriptor | undefined {
        const active = this.#snapshot.sessions[this.#snapshot.selectedIndex];
        if (active !== undefined) this.#update({ ...this.#snapshot, active });
        return active;
    }
    leave(): void {
        this.#update({ ...this.#snapshot, active: undefined });
    }
    dispose(): void {
        ++this.#revision;
        this.#listeners.clear();
    }
    #update(snapshot: SharedTerminalSnapshot): void {
        this.#snapshot = snapshot;
        for (const listener of this.#listeners) listener();
    }
}
