import type { ExtensionGeneration } from "./Generation.js";

export interface ExtensionRetiredGenerationRecord {
    generation: string;
    inFlight: number;
    state: ExtensionGeneration["state"];
}

export class ExtensionRetirementTracker {
    readonly #failures = new Map<string, unknown[]>();
    readonly #onFailure: (
        id: string,
        generation: string,
        error: unknown,
    ) => void;
    readonly #promises = new Set<Promise<void>>();
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
        const retirement = generation.retire();
        this.#promises.add(retirement);
        void retirement
            .catch((error: unknown) => {
                const failures = this.#failures.get(id) ?? [];
                failures.push(error);
                this.#failures.set(id, failures);
                this.#onFailure(id, generation.generation, error);
            })
            .finally(() => {
                this.#promises.delete(retirement);
                retired.delete(generation);
                if (retired.size === 0) this.#retired.delete(id);
            });
    }

    has(id: string): boolean {
        return (
            (this.#retired.get(id)?.size ?? 0) > 0 ||
            (this.#failures.get(id)?.length ?? 0) > 0
        );
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
            retired.map(async (generation) => await generation.retire()),
        );
        const failures = uniqueFailures([
            ...(this.#failures.get(id) ?? []),
            ...settled.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
            ),
        ]);
        this.#failures.delete(id);
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Extension ${id} failed to drain cleanly.`,
            );
        }
    }

    async drainAll(): Promise<void> {
        const settled = await Promise.allSettled([...this.#promises]);
        const failures = uniqueFailures([
            ...settled.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
            ),
            ...[...this.#failures.values()].flat(),
        ]);
        this.#failures.clear();
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
