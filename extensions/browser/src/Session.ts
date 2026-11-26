import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { ExtensionWorkerProcess } from "@portable-devshell/extension/worker";
import { decodeMessage, encodeMessage, encodeRecord, WireDecoder, WireKind } from "./Wire.js";

interface Reply {
    id?: number;
    result?: ExtensionJsonValue;
    error?: string;
    event?: "request";
    method?: string;
    url?: string;
    status?: number;
}
interface Pending {
    resolve(value: ExtensionJsonValue): void;
    reject(reason: Error): void;
}

/** One profile's Worker process. Only the latest complete frame is retained. */
export class BrowserSession {
    readonly #pending = new Map<number, Pending>();
    readonly #waiters = new Set<() => void>();
    readonly #reader: Promise<void>;
    #writes: Promise<void> = Promise.resolve();
    #id = 0;
    #closed = false;
    #frame?: { sequence: number; bytes: Uint8Array };
    #viewers = 0;
    #cast: Promise<ExtensionJsonValue> = Promise.resolve(null);

    constructor(
        private readonly process: ExtensionWorkerProcess,
        private readonly onRequest: (event: { method: string; url: string; status: number }) => Promise<void>,
        private readonly onFailure: (error: unknown) => void,
    ) {
        this.#reader = this.#read().catch(error => {
            this.onFailure(error);
            this.#end(error instanceof Error ? error : new Error(String(error)));
        }).finally(() => this.process.close());
    }

    get closed() { return this.#closed; }

    request(op: string, args: ExtensionJsonValue = null): Promise<ExtensionJsonValue> {
        if (this.#closed) return Promise.reject(new Error("Browser session is closed."));
        const id = ++this.#id;
        const result = new Promise<ExtensionJsonValue>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
        const packet = encodeMessage({ id, op, args });
        this.#writes = this.#writes.then(() => this.process.write(packet)).catch(error => {
            this.#end(error instanceof Error ? error : new Error(String(error)));
        });
        return result;
    }

    async *frames(signal: AbortSignal): AsyncGenerator<Uint8Array> {
        signal.throwIfAborted();
        this.#viewers++;
        if (this.#viewers === 1) this.#cast = this.#cast.catch(() => null).then(() => this.request("cast", true));
        try {
            await this.#cast;
            let sequence = 0;
            while (!this.#closed && !signal.aborted) {
                if (this.#frame !== undefined && this.#frame.sequence > sequence) {
                    sequence = this.#frame.sequence;
                    yield this.#frame.bytes;
                } else {
                    await new Promise<void>(resolve => {
                        const done = () => {
                            this.#waiters.delete(done);
                            signal.removeEventListener("abort", done);
                            resolve();
                        };
                        this.#waiters.add(done);
                        signal.addEventListener("abort", done, { once: true });
                        if (signal.aborted || this.#closed || (this.#frame?.sequence ?? 0) > sequence) done();
                    });
                }
            }
        } finally {
            if (--this.#viewers === 0 && !this.#closed) {
                this.#cast = this.#cast.catch(() => null).then(() => this.request("cast", false));
                await this.#cast;
            }
        }
    }

    async close(): Promise<void> {
        if (!this.#closed) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([this.request("close"), new Promise<void>(resolve => { timer = setTimeout(resolve, 8000); })]);
            } finally {
                if (timer !== undefined) clearTimeout(timer);
                await this.process.close();
            }
        } else {
            await this.process.close();
        }
        await this.#reader;
    }

    async #read(): Promise<void> {
        const decoder = new WireDecoder();
        for (;;) {
            const bytes = await this.process.read();
            if (bytes === undefined) break;
            for (const record of decoder.push(bytes)) {
                if (record.kind === WireKind.frame) {
                    this.#frame = { sequence: (this.#frame?.sequence ?? 0) + 1, bytes: encodeRecord(record.kind, record.data) };
                    for (const wake of this.#waiters) wake();
                    continue;
                }
                const reply = decodeMessage(record) as Reply;
                if (reply.event === "request" && reply.method !== undefined && reply.url !== undefined && reply.status !== undefined) {
                    await this.onRequest({ method: reply.method, url: reply.url, status: reply.status });
                } else if (reply.id !== undefined) {
                    const pending = this.#pending.get(reply.id);
                    this.#pending.delete(reply.id);
                    if (reply.error !== undefined) pending?.reject(new Error(reply.error));
                    else pending?.resolve(reply.result ?? null);
                }
            }
        }
        this.#end(new Error("Browser Worker process exited."));
    }

    #end(error: Error): void {
        this.#closed = true;
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        for (const wake of this.#waiters) wake();
    }
}
