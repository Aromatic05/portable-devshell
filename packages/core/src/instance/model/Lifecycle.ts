import type { Instance } from "./Instance.js";

export interface InstanceLease {
    readonly instance: Instance;
    release(): void;
}

export class InstanceLifecycle {
    #admitted = 0;
    #phase: "active" | "retiring" | "retired" | "closed" = "active";
    readonly #waiters = new Set<() => void>();

    constructor(private readonly instance: Instance) {}

    get active(): boolean {
        return this.#phase === "active";
    }

    get closed(): boolean {
        return this.#phase === "closed";
    }

    get phase(): "active" | "retiring" | "retired" | "closed" {
        return this.#phase;
    }

    get retired(): boolean {
        return this.#phase === "retired" || this.#phase === "closed";
    }

    acquireLease(): InstanceLease {
        if (!this.active) {
            throw new Error(
                `Instance generation ${this.instance.config.name} is retired.`,
            );
        }
        this.#admitted += 1;
        let released = false;
        return {
            instance: this.instance,
            release: () => {
                if (released) return;
                released = true;
                this.#admitted -= 1;
                if (this.#admitted !== 0) return;
                for (const waiter of this.#waiters) waiter();
                this.#waiters.clear();
            },
        };
    }

    beginRetirement(): void {
        if (this.#phase === "active") this.#phase = "retiring";
    }

    async drain(): Promise<void> {
        if (this.#admitted === 0) return;
        await new Promise<void>((resolve) => {
            if (this.#admitted === 0) resolve();
            else this.#waiters.add(resolve);
        });
    }

    completeRetirement(): void {
        if (this.#phase === "retired" || this.#phase === "closed") return;
        if (this.#phase !== "retiring") {
            throw new Error(
                `Instance generation ${this.instance.config.name} cannot retire from ${this.#phase}.`,
            );
        }
        this.#phase = "retired";
    }

    completeClose(): void {
        if (this.#phase === "closed") return;
        if (this.#phase === "active") {
            throw new Error(
                `Instance generation ${this.instance.config.name} cannot close while active.`,
            );
        }
        this.#phase = "closed";
    }
}
