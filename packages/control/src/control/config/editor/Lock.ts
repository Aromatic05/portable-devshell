export interface ControlConfigMutationRunner {
    runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export class ControlConfigMutationLock implements ControlConfigMutationRunner {
    #tail: Promise<void> = Promise.resolve();

    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}
