import type { WebState } from "./WebState.js";
import { withWebRequestTimeout } from "./WebRequestTimeout.js";

export interface InstanceReadModelAccess {
    getState(): WebState;
    isCurrent(generation: number): boolean;
    setState(state: WebState): void;
}

export interface InstanceReadResult<T> {
    failure?: string;
    value?: T;
}

export interface InstanceReadModelChannelOptions<T> {
    access: InstanceReadModelAccess;
    apply(state: WebState, instance: string, value: T): WebState;
    key: string;
    request(instance: string): Promise<T>;
    timeoutMs: number;
}

export class InstanceReadModelChannel<T> {
    #timers = new Map<string, ReturnType<typeof setTimeout>>();
    #versions = new Map<string, number>();

    constructor(private readonly options: InstanceReadModelChannelOptions<T>) {}

    failureKey(instance: string): string {
        return `${this.options.key}:${instance}`;
    }

    async load(instance: string): Promise<InstanceReadResult<T>> {
        try {
            return { value: await this.request(instance) };
        } catch (error) {
            return { failure: errorMessage(error) };
        }
    }

    async refresh(instance: string, generation: number): Promise<void> {
        const version = this.invalidate(instance);
        try {
            const value = await this.request(instance);
            if (!this.isCurrent(instance, version, generation)) return;
            const state = this.options.access.getState();
            this.options.access.setState({
                ...this.options.apply(state, instance, value),
                partialFailures: withoutFailure(
                    state.partialFailures,
                    this.failureKey(instance),
                ),
            });
        } catch (error) {
            if (!this.isCurrent(instance, version, generation)) return;
            const state = this.options.access.getState();
            this.options.access.setState({
                ...state,
                partialFailures: {
                    ...state.partialFailures,
                    [this.failureKey(instance)]: errorMessage(error),
                },
            });
        }
    }

    schedule(instance: string, generation: number): void {
        if (this.#timers.has(instance)) return;
        const timeout = setTimeout(() => {
            this.#timers.delete(instance);
            void this.refresh(instance, generation);
        }, 250);
        this.#timers.set(instance, timeout);
    }

    invalidate(instance: string): number {
        const version = (this.#versions.get(instance) ?? 0) + 1;
        this.#versions.set(instance, version);
        return version;
    }

    reset(): void {
        for (const timeout of this.#timers.values()) clearTimeout(timeout);
        this.#timers.clear();
        this.#versions.clear();
    }

    private async request(instance: string): Promise<T> {
        return await withWebRequestTimeout(
            this.options.request(instance),
            this.options.timeoutMs,
            this.failureKey(instance),
        );
    }

    private isCurrent(
        instance: string,
        version: number,
        generation: number,
    ): boolean {
        return this.options.access.isCurrent(generation) &&
            this.#versions.get(instance) === version;
    }
}

function withoutFailure(
    failures: Record<string, string>,
    key: string,
): Record<string, string> {
    const { [key]: _removed, ...remaining } = failures;
    return remaining;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
