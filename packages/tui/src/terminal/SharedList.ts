import type {
    TerminalOpenInput,
    TerminalSessionDescriptor,
    TerminalVersionedIdentity,
} from "@portable-devshell/shared";

export type SharedTerminalMode = "observe" | "control";

export interface SharedTerminalSnapshot {
    instance?: string;
    active?: TerminalSessionDescriptor;
    mode?: SharedTerminalMode;
    sessions: readonly TerminalSessionDescriptor[];
    selectedIndex: number;
    loading: boolean;
    error?: string;
}

export interface TuiSharedTerminalOperations {
    list(instance: string): Promise<TerminalSessionDescriptor[]>;
    open?(
        instance: string,
        input: Omit<TerminalOpenInput, "workspace">,
    ): Promise<TerminalSessionDescriptor>;
    kill?(
        instance: string,
        identity: TerminalVersionedIdentity,
    ): Promise<TerminalSessionDescriptor>;
}

export class TuiSharedTerminalList {
    readonly #operations: TuiSharedTerminalOperations;
    #snapshot: SharedTerminalSnapshot = {
        sessions: [],
        selectedIndex: 0,
        loading: false,
    };
    #revision = 0;
    readonly #listeners = new Set<() => void>();

    constructor(
        source:
            | ((instance: string) => Promise<TerminalSessionDescriptor[]>)
            | TuiSharedTerminalOperations,
    ) {
        this.#operations =
            typeof source === "function" ? { list: source } : source;
    }

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
            const sessions = (await this.#operations.list(instance)).filter(
                (session) => session.state === "running",
            );
            if (revision !== this.#revision) return;
            const index = sessions.findIndex(
                (session) => session.terminalId === selected,
            );
            const active =
                this.#snapshot.active === undefined
                    ? undefined
                    : (sessions.find(
                          (session) =>
                              session.terminalId ===
                              this.#snapshot.active?.terminalId,
                      ) ?? this.#snapshot.active);
            this.#update({
                ...this.#snapshot,
                active,
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
    enter(mode: SharedTerminalMode = "control"): TerminalSessionDescriptor | undefined {
        const active = this.#snapshot.sessions[this.#snapshot.selectedIndex];
        if (active !== undefined)
            this.#update({ ...this.#snapshot, active, error: undefined, mode });
        return active;
    }
    setMode(mode: SharedTerminalMode): void {
        if (this.#snapshot.active === undefined) return;
        this.#update({
            ...this.#snapshot,
            active: {
                ...this.#snapshot.active,
                humanControl: mode === "control",
            },
            error: undefined,
            mode,
        });
    }
    setError(error?: string): void {
        this.#update({ ...this.#snapshot, error });
    }
    async create(
        cols: number,
        rows: number,
    ): Promise<TerminalSessionDescriptor | undefined> {
        const instance = this.#snapshot.instance;
        if (instance === undefined || this.#operations.open === undefined)
            return undefined;
        this.#update({ ...this.#snapshot, loading: true, error: undefined });
        try {
            const created = await this.#operations.open(instance, {
                cols,
                persistent: true,
                rows,
            });
            await this.refresh();
            const index = this.#snapshot.sessions.findIndex(
                (session) => session.terminalId === created.terminalId,
            );
            this.#update({
                ...this.#snapshot,
                active: created,
                error: undefined,
                loading: false,
                mode: "control",
                selectedIndex: index >= 0 ? index : this.#snapshot.selectedIndex,
            });
            return created;
        } catch (error) {
            this.#update({
                ...this.#snapshot,
                error: error instanceof Error ? error.message : String(error),
                loading: false,
            });
            return undefined;
        }
    }
    async closeSelected(): Promise<boolean> {
        const instance = this.#snapshot.instance;
        const selected = this.#snapshot.sessions[this.#snapshot.selectedIndex];
        if (
            instance === undefined ||
            selected === undefined ||
            this.#operations.kill === undefined
        )
            return false;
        this.#update({ ...this.#snapshot, loading: true, error: undefined });
        try {
            try {
                await this.#operations.kill(instance, {
                    generation: selected.generation,
                    terminalId: selected.terminalId,
                    version: selected.version,
                });
            } catch (error) {
                if (!isStaleVersionConflict(error)) throw error;
                await this.refresh();
                if (this.#snapshot.error !== undefined) return false;
                const fresh = this.#snapshot.sessions.find(
                    (session) =>
                        session.terminalId === selected.terminalId &&
                        session.state === "running",
                );
                if (fresh === undefined) return true;
                await this.#operations.kill(instance, {
                    generation: fresh.generation,
                    terminalId: fresh.terminalId,
                    version: fresh.version,
                });
            }
            await this.refresh();
            return this.#snapshot.error === undefined;
        } catch (error) {
            this.#update({
                ...this.#snapshot,
                error: error instanceof Error ? error.message : String(error),
                loading: false,
            });
            return false;
        }
    }
    leave(): void {
        this.#update({ ...this.#snapshot, active: undefined, mode: undefined });
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

function isStaleVersionConflict(error: unknown): boolean {
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "instance.conflict"
    ) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("version");
}
