import {
    createError,
    errorCodes,
    type JsonValue,
    type PrefixRouteEvent,
    type PrefixRouteStream
} from "@portable-devshell/shared";
import type { CliCommandInputOptions, CliCommandIo } from "@portable-devshell/extension/cli";

export class CliCommandStreamIo implements CliCommandIo {
    readonly #queue: Buffer[] = [];
    readonly #waiters: Array<(chunk: Buffer | undefined) => void> = [];
    #closed = false;
    #stream?: PrefixRouteStream;

    bind(stream: PrefixRouteStream): void {
        if (this.#stream !== undefined) {
            throw new Error("CLI command stream I/O is already bound.");
        }
        this.#stream = stream;
    }

    accept(event: PrefixRouteEvent): void {
        if (this.#closed) return;
        if (event.name === "eof") {
            this.closeInput();
            return;
        }
        if (event.name !== "input") {
            throw createError({
                code: errorCodes.envelopeInvalid,
                message: `CLI command stream does not accept ${event.name}.`,
                retryable: false
            });
        }
        const payload = record(event.payload);
        if (typeof payload?.data !== "string") {
            throw createError({
                code: errorCodes.targetInvalid,
                message: "cli.input requires base64 data.",
                retryable: false
            });
        }
        this.#push(Buffer.from(payload.data, "base64"));
    }

    closeInput(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    }

    async readInput(): Promise<Buffer | undefined> {
        const chunk = this.#queue.shift();
        if (chunk !== undefined) return chunk;
        if (this.#closed) return undefined;
        return await new Promise<Buffer | undefined>((resolve) => this.#waiters.push(resolve));
    }

    async requestInput(options: CliCommandInputOptions = {}): Promise<void> {
        await this.#requireStream().emit("terminal", { raw: options.raw === true });
    }

    async writeStderr(chunk: string): Promise<void> {
        await this.#write("stderr", chunk);
    }

    async writeStdout(chunk: string): Promise<void> {
        await this.#write("stdout", chunk);
    }

    async #write(name: "stderr" | "stdout", chunk: string): Promise<void> {
        if (chunk.length === 0) return;
        await this.#requireStream().emit(name, { chunk });
    }

    #push(chunk: Buffer): void {
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(chunk);
        else this.#queue.push(chunk);
    }

    #requireStream(): PrefixRouteStream {
        if (this.#stream === undefined) throw new Error("CLI command stream I/O is not bound.");
        return this.#stream;
    }
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
