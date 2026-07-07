export class StreamBackpressure {
    #pending = Promise.resolve();

    push<T>(write: () => Promise<T>): Promise<T> {
        const next = this.#pending.then(write, write);
        this.#pending = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }
}
