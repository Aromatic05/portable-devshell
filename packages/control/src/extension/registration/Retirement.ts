import type { ExtensionGeneration } from "./Generation.js";

export interface ExtensionRetiredGenerationRecord {
    generation: string;
    inFlight: number;
    state: ExtensionGeneration["state"];
}

export class ExtensionRetirementTracker {
    readonly #onFailure: (
        id: string,
        generation: string,
        error: unknown,
    ) => void;
    readonly #promises = new Map<ExtensionGeneration, Promise<void>>();
    readonly #retired = new Map<string, Set<ExtensionGeneration>>();

    constructor(
        onFailure: (
            id: string,
            generation: string,
            error: unknown,
        ) => void,
    ) {
        this.#onFailure = onFailure;
    }

    track(id: string, generation: ExtensionGeneration): void {
        const retired = this.#retired.get(id) ?? new Set<ExtensionGeneration>();
        retired.add(generation);
        this.#retired.set(id, retired);
        void this.#retire(id, generation).catch(() => undefined);
    }

    #retire(id: string, generation: ExtensionGeneration): Promise<void> {
        const pending = this.#promises.get(generation);
        if (pending !== undefined) return pending;
        const retirement = generation.retire().then(
            () => {
                this.#promises.delete(generation);
                const retired = this.#retired.get(id)!;
                retired.delete(generation);
                if (retired.size === 0) this.#retired.delete(id);
            },
            (error: unknown) => {
                this.#promises.delete(generation);
                this.#onFailure(id, generation.generation, error);
                throw error;
            },
        );
        this.#promises.set(generation, retirement);
        return retirement;
    }

    has(id: string): boolean {
        return (this.#retired.get(id)?.size ?? 0) > 0;
    }

    list(id: string): ExtensionRetiredGenerationRecord[] {
        return [...(this.#retired.get(id) ?? [])].map((generation) => ({
            generation: generation.generation,
            inFlight: generation.inFlight,
            state: generation.state,
        }));
    }

    async waitForDrain(id: string): Promise<void> {
        const retired = [...(this.#retired.get(id) ?? [])];
        const settled = await Promise.allSettled(
            retired.map((generation) => this.#retire(id, generation)),
        );
        const failures = uniqueFailures([
            ...settled.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
            ),
        ]);
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Extension ${id} failed to drain cleanly.`,
            );
        }
    }

    async drainAll(): Promise<void> {
        const settled = await Promise.allSettled(
            [...this.#retired].flatMap(([id, generations]) =>
                [...generations].map((generation) => this.#retire(id, generation)),
            ),
        );
        const failures = uniqueFailures([
            ...settled.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
            ),
        ]);
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "Extension generations failed to dispose cleanly.",
            );
        }
    }
}

function uniqueFailures(failures: readonly unknown[]): unknown[] {
    const unique: unknown[] = [];
    const seen = new Set<unknown>();
    for (const failure of failures) {
        if (seen.has(failure)) continue;
        seen.add(failure);
        unique.push(failure);
    }
    return unique;
}
