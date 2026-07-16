import type { WorkerCommandInteractiveSession } from "@portable-devshell/core";
import { createError, errorCodes, type JsonValue, type PrefixRouteEvent } from "@portable-devshell/shared";

export class RuntimeInteractiveSession implements WorkerCommandInteractiveSession {
    readonly #queue: Buffer[] = [];
    readonly #waiters: Array<(chunk: Buffer | undefined) => void> = [];
    #closed = false;
    #writeOutput?: (chunk: string) => Promise<void>;

    bindOutput(writeOutput: (chunk: string) => Promise<void>): void {
        this.#writeOutput = writeOutput;
    }

    accept(event: PrefixRouteEvent): void {
        if (this.#closed) {
            return;
        }
        if (event.name === "eof") {
            this.closeInput();
            return;
        }
        if (event.name !== "input") {
            throw createError({
                code: errorCodes.envelopeInvalid,
                message: `Interactive runtime does not accept ${event.name}.`,
                retryable: false
            });
        }
        if (!isRecord(event.payload) || typeof event.payload.data !== "string") {
            throw createError({
                code: errorCodes.targetInvalid,
                message: "runtime.input requires base64 data.",
                retryable: false
            });
        }
        this.#push(Buffer.from(event.payload.data, "base64"));
    }

    async readInput(): Promise<Buffer | undefined> {
        const chunk = this.#queue.shift();
        if (chunk !== undefined) {
            return chunk;
        }
        if (this.#closed) {
            return undefined;
        }
        return await new Promise<Buffer | undefined>((resolve) => this.#waiters.push(resolve));
    }

    async writeOutput(chunk: string): Promise<void> {
        if (chunk.length === 0) {
            return;
        }
        if (this.#writeOutput === undefined) {
            throw new Error("Interactive runtime output is not bound.");
        }
        await this.#writeOutput(chunk);
    }

    closeInput(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        for (const waiter of this.#waiters.splice(0)) {
            waiter(undefined);
        }
    }

    #push(chunk: Buffer): void {
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) {
            waiter(chunk);
        } else {
            this.#queue.push(chunk);
        }
    }
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
