export interface FrameStream {
    readonly id: number;
    readonly service: string;
    readonly metadata: Uint8Array;
    readonly closed: boolean;

    write(data: Uint8Array): Promise<void>;
    read(): Promise<Uint8Array | undefined>;
    finish(): Promise<void>;
    reset(code: number, message?: string): Promise<void>;
}

export class FrameResetError extends Error {
    readonly resetCode: number;

    constructor(resetCode: number, message = "Frame stream was reset.") {
        super(message || "Frame stream was reset.");
        this.name = "FrameResetError";
        this.resetCode = resetCode;
    }
}

export interface FrameStreamHost {
    writeStream(stream: FrameStreamState, data: Uint8Array): Promise<void>;
    finishStream(stream: FrameStreamState): Promise<void>;
    resetStream(
        stream: FrameStreamState,
        code: number,
        message: string,
    ): Promise<void>;
    consumeStream(stream: FrameStreamState, byteLength: number): Promise<void>;
}

interface ReadWaiter {
    resolve(value: Uint8Array | undefined): void;
    reject(error: Error): void;
}

interface CreditWaiter {
    resolve(): void;
    reject(error: Error): void;
}

export class FrameStreamState implements FrameStream {
    readonly id: number;
    readonly service: string;
    readonly metadata: Uint8Array;
    readonly #host: FrameStreamHost;
    readonly #incoming: Uint8Array[] = [];
    readonly #readWaiters: ReadWaiter[] = [];
    readonly #creditWaiters: CreditWaiter[] = [];
    #accepted: boolean;
    #failure?: Error;
    #localFin = false;
    #remoteFin = false;
    #sendCredit: number;
    #receiveCredit: number;
    #unconsumedBytes = 0;
    #operationTail: Promise<void> = Promise.resolve();

    constructor(options: {
        host: FrameStreamHost;
        id: number;
        service: string;
        metadata: Uint8Array;
        accepted: boolean;
        sendCredit: number;
        receiveCredit: number;
    }) {
        this.#host = options.host;
        this.id = options.id;
        this.service = options.service;
        this.metadata = Uint8Array.from(options.metadata);
        this.#accepted = options.accepted;
        this.#sendCredit = options.sendCredit;
        this.#receiveCredit = options.receiveCredit;
    }

    get accepted(): boolean {
        return this.#accepted;
    }

    get closed(): boolean {
        return (
            this.#failure !== undefined ||
            (this.#localFin && this.#remoteFin && this.#unconsumedBytes === 0)
        );
    }

    get localFinished(): boolean {
        return this.#localFin;
    }

    get remoteFinished(): boolean {
        return this.#remoteFin;
    }

    get sendCredit(): number {
        return this.#sendCredit;
    }

    get receiveCredit(): number {
        return this.#receiveCredit;
    }

    get failure(): Error | undefined {
        return this.#failure;
    }

    accept(receiveCredit: number): void {
        this.#throwIfFailed();
        if (this.#accepted)
            throw new Error("Frame stream is already accepted.");
        this.#accepted = true;
        this.#receiveCredit = receiveCredit;
    }

    async write(data: Uint8Array): Promise<void> {
        this.#throwIfFailed();
        if (!this.#accepted) throw new Error("Frame stream is not accepted.");
        if (this.#localFin)
            throw new Error("Frame stream write side is closed.");
        if (data.byteLength === 0) return;
        await this.#serialize(() => this.#host.writeStream(this, data));
    }

    async read(): Promise<Uint8Array | undefined> {
        this.#throwIfFailed();
        if (!this.#accepted) throw new Error("Frame stream is not accepted.");
        const value = await this.#nextIncoming();
        if (value === undefined) return undefined;
        this.#unconsumedBytes -= value.byteLength;
        try {
            await this.#host.consumeStream(this, value.byteLength);
        } catch (error) {
            throw normalizeError(error);
        }
        return value;
    }

    async finish(): Promise<void> {
        this.#throwIfFailed();
        if (!this.#accepted) throw new Error("Frame stream is not accepted.");
        if (this.#localFin) return;
        await this.#serialize(async () => {
            if (this.#localFin) return;
            this.#localFin = true;
            await this.#host.finishStream(this);
        });
    }

    async reset(code: number, message = ""): Promise<void> {
        if (this.#failure !== undefined) return;
        await this.#host.resetStream(this, code, message);
    }

    addIncoming(data: Uint8Array): void {
        this.#throwIfFailed();
        if (this.#remoteFin) {
            throw new Error("Frame stream received DATA after FIN.");
        }
        const copy = Uint8Array.from(data);
        this.#unconsumedBytes += copy.byteLength;
        const waiter = this.#readWaiters.shift();
        if (waiter !== undefined) waiter.resolve(copy);
        else this.#incoming.push(copy);
    }

    markRemoteFinished(): void {
        this.#throwIfFailed();
        if (this.#remoteFin)
            throw new Error("Frame stream received duplicate FIN.");
        this.#remoteFin = true;
        if (this.#incoming.length === 0 && this.#unconsumedBytes === 0) {
            for (const waiter of this.#readWaiters.splice(0)) {
                waiter.resolve(undefined);
            }
        }
    }

    grantSendCredit(delta: number): void {
        this.#throwIfFailed();
        this.#sendCredit += delta;
        for (const waiter of this.#creditWaiters.splice(0)) waiter.resolve();
    }

    takeSendCredit(max: number): number {
        this.#throwIfFailed();
        const taken = Math.min(max, this.#sendCredit);
        this.#sendCredit -= taken;
        return taken;
    }

    spendReceiveCredit(byteLength: number): void {
        this.#throwIfFailed();
        if (byteLength > this.#receiveCredit) {
            throw new Error("Frame stream exceeded receive credit.");
        }
        this.#receiveCredit -= byteLength;
    }

    restoreReceiveCredit(byteLength: number): void {
        this.#throwIfFailed();
        this.#receiveCredit += byteLength;
    }

    async waitForSendCredit(): Promise<void> {
        this.#throwIfFailed();
        if (this.#sendCredit > 0) return;
        await new Promise<void>((resolve, reject) => {
            this.#creditWaiters.push({ resolve, reject });
        });
        this.#throwIfFailed();
    }

    fail(error: Error): void {
        if (this.#failure !== undefined) return;
        this.#failure = error;
        this.#incoming.length = 0;
        this.#unconsumedBytes = 0;
        for (const waiter of this.#readWaiters.splice(0)) waiter.reject(error);
        for (const waiter of this.#creditWaiters.splice(0))
            waiter.reject(error);
    }

    #nextIncoming(): Promise<Uint8Array | undefined> {
        const next = this.#incoming.shift();
        if (next !== undefined) return Promise.resolve(next);
        if (this.#remoteFin) return Promise.resolve(undefined);
        return new Promise<Uint8Array | undefined>((resolve, reject) => {
            this.#readWaiters.push({ resolve, reject });
        });
    }

    #serialize(action: () => Promise<void>): Promise<void> {
        const run = this.#operationTail.then(action);
        this.#operationTail = run.catch(() => undefined);
        return run;
    }

    #throwIfFailed(): void {
        if (this.#failure !== undefined) throw this.#failure;
    }
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
