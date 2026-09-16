import type { Channel } from "../protocol/Channel.js";
import type { ErrorCode } from "../../protocol/Error.js";
import { createError } from "../../protocol/Error.js";
import {
    FRAME_MAX_DATA_SIZE,
    FrameBuffer,
    FrameResetCode,
    encodeFrame,
    frameResetCodes,
    type Frame,
} from "./Codec.js";
import {
    FrameResetError,
    FrameStreamState,
    type FrameStream,
    type FrameStreamHost,
} from "./Stream.js";

const DEFAULT_RECEIVE_WINDOW = 256 * 1024;
const UINT32_MAX = 0xffff_ffff;

export interface FrameProtocolOptions {
    role: "opener" | "acceptor";
    maxDataSize?: number;
    receiveWindow?: number;
}

export interface FrameOpenOptions {
    receiveWindow?: number;
}

export interface FrameOpenRequest {
    readonly streamId: number;
    readonly service: string;
    readonly metadata: Uint8Array;
    accept(options?: FrameOpenOptions): Promise<FrameStream>;
    reset(code?: number, message?: string): Promise<void>;
}

interface OpenWaiter {
    resolve(value: FrameOpenRequest | undefined): void;
}

interface DataJob {
    readonly stream: FrameStreamState;
    readonly data: Uint8Array;
    resolve(): void;
    reject(error: Error): void;
}

export class FrameProtocol implements FrameStreamHost {
    readonly #channel: Channel;
    readonly #frames = new FrameBuffer();
    readonly #role: FrameProtocolOptions["role"];
    readonly #maxDataSize: number;
    readonly #defaultReceiveWindow: number;
    readonly #streams = new Map<number, FrameStreamState>();
    readonly #pendingOpen: FrameOpenRequestImpl[] = [];
    readonly #openWaiters: OpenWaiter[] = [];
    readonly #dataJobs: DataJob[] = [];
    #nextStreamId = 1;
    #lastRemoteStreamId = 0;
    #closed = false;
    #closeError?: Error;
    #writeTail: Promise<void> = Promise.resolve();
    #dataPumping = false;

    constructor(channel: Channel, options: FrameProtocolOptions) {
        this.#channel = channel;
        this.#role = options.role;
        this.#maxDataSize = options.maxDataSize ?? FRAME_MAX_DATA_SIZE;
        this.#defaultReceiveWindow =
            options.receiveWindow ?? DEFAULT_RECEIVE_WINDOW;
        assertPositiveU32(this.#defaultReceiveWindow, "receiveWindow");
        if (
            !Number.isInteger(this.#maxDataSize) ||
            this.#maxDataSize <= 0 ||
            this.#maxDataSize > FRAME_MAX_DATA_SIZE
        ) {
            throw new Error(
                `maxDataSize must be between 1 and ${FRAME_MAX_DATA_SIZE}.`,
            );
        }

        channel.onData((data) => this.#acceptData(data));
        channel.onClose((error) =>
            this.#finish(
                error ??
                    (this.#frames.empty
                        ? undefined
                        : protocolError(
                              "Channel closed with an incomplete Frame.",
                          )),
            ),
        );
    }

    get closed(): boolean {
        return this.#closed;
    }

    async open(
        service: string,
        metadata: Uint8Array = new Uint8Array(),
        options: FrameOpenOptions = {},
    ): Promise<FrameStream> {
        this.#assertOpen();
        if (this.#role !== "opener") {
            throw new Error("Only the Frame opener can open a Service stream.");
        }
        const receiveWindow =
            options.receiveWindow ?? this.#defaultReceiveWindow;
        assertPositiveU32(receiveWindow, "receiveWindow");
        if (this.#nextStreamId > UINT32_MAX) {
            const error = protocolError("Frame stream id space is exhausted.");
            this.close(error);
            throw error;
        }
        const streamId = this.#nextStreamId++;
        const stream = new FrameStreamState({
            host: this,
            id: streamId,
            service,
            metadata,
            accepted: true,
            sendCredit: 0,
            receiveCredit: receiveWindow,
        });
        this.#streams.set(streamId, stream);
        try {
            await this.#writeFrame({
                type: "open",
                streamId,
                receiveWindow,
                service,
                metadata,
            });
            return stream;
        } catch (error) {
            this.#streams.delete(streamId);
            stream.fail(normalizeError(error));
            throw error;
        }
    }

    async nextOpen(): Promise<FrameOpenRequest | undefined> {
        if (this.#role !== "acceptor") {
            throw new Error(
                "Only the Frame acceptor can receive Service opens.",
            );
        }
        const request = this.#pendingOpen.shift();
        if (request !== undefined) return request;
        if (this.#closed) return undefined;
        return await new Promise<FrameOpenRequest | undefined>((resolve) => {
            this.#openWaiters.push({ resolve });
        });
    }

    close(error?: Error): void {
        if (this.#closed) return;
        try {
            this.#channel.close(error);
        } catch (cause) {
            error ??= normalizeError(cause);
        }
        this.#finish(error);
    }

    async writeStream(
        stream: FrameStreamState,
        data: Uint8Array,
    ): Promise<void> {
        this.#assertCurrent(stream);
        let offset = 0;
        while (offset < data.byteLength) {
            await stream.waitForSendCredit();
            this.#assertCurrent(stream);
            const byteLength = stream.takeSendCredit(
                Math.min(this.#maxDataSize, data.byteLength - offset),
            );
            if (byteLength <= 0) continue;
            const chunk = data.slice(offset, offset + byteLength);
            try {
                await this.#scheduleData(stream, chunk);
            } catch (error) {
                stream.grantSendCredit(byteLength);
                throw error;
            }
            offset += byteLength;
        }
    }

    async finishStream(stream: FrameStreamState): Promise<void> {
        this.#assertCurrent(stream);
        await this.#writeFrame({ type: "fin", streamId: stream.id });
        this.#cleanupIfClosed(stream);
    }

    async resetStream(
        stream: FrameStreamState,
        code: number,
        message: string,
    ): Promise<void> {
        this.#assertCurrent(stream);
        const error = new FrameResetError(code, message);
        this.#streams.delete(stream.id);
        this.#rejectDataJobs(stream, error);
        stream.fail(error);
        await this.#writeFrame({
            type: "reset",
            streamId: stream.id,
            code,
            message,
        });
    }

    async consumeStream(
        stream: FrameStreamState,
        byteLength: number,
    ): Promise<void> {
        this.#assertCurrent(stream);
        if (byteLength <= 0) return;
        if (!stream.remoteFinished) {
            await this.#writeFrame({
                type: "window",
                streamId: stream.id,
                creditDelta: byteLength,
            });
            if (stream.receiveCredit > UINT32_MAX - byteLength) {
                throw this.#connectionError("Frame receive credit overflow.");
            }
            stream.restoreReceiveCredit(byteLength);
        }
        this.#cleanupIfClosed(stream);
    }

    async #acceptOpen(request: FrameOpenRequestImpl, receiveWindow: number) {
        this.#assertOpen();
        const stream = request.stream;
        this.#assertCurrent(stream);
        if (stream.accepted) {
            throw new Error("Frame open request is already accepted.");
        }
        assertPositiveU32(receiveWindow, "receiveWindow");
        stream.accept(receiveWindow);
        await this.#writeFrame({
            type: "window",
            streamId: stream.id,
            creditDelta: receiveWindow,
        });
        return stream;
    }

    async #rejectOpen(
        request: FrameOpenRequestImpl,
        code: number,
        message: string,
    ): Promise<void> {
        const stream = request.stream;
        if (this.#streams.get(stream.id) !== stream) return;
        this.#streams.delete(stream.id);
        const error = new FrameResetError(code, message);
        stream.fail(error);
        await this.#writeFrame({
            type: "reset",
            streamId: stream.id,
            code,
            message,
        });
    }

    #acceptData(data: Uint8Array): void {
        if (this.#closed) return;
        try {
            for (const frame of this.#frames.push(data))
                this.#acceptFrame(frame);
        } catch (error) {
            this.#connectionError(normalizeError(error).message);
        }
    }

    #acceptFrame(frame: Frame): void {
        if (frame.type === "open") {
            this.#acceptOpenFrame(frame);
            return;
        }
        const stream = this.#streams.get(frame.streamId);
        if (stream === undefined) {
            throw this.#connectionError(
                `Frame references unknown stream ${frame.streamId}.`,
            );
        }
        if (!stream.accepted) {
            throw this.#connectionError(
                `Frame stream ${frame.streamId} is not accepted yet.`,
            );
        }
        switch (frame.type) {
            case "data":
                if (stream.remoteFinished) {
                    throw this.#connectionError(
                        `Frame stream ${frame.streamId} received DATA after FIN.`,
                    );
                }
                try {
                    stream.spendReceiveCredit(frame.data.byteLength);
                    stream.addIncoming(frame.data);
                } catch (error) {
                    throw this.#connectionError(normalizeError(error).message);
                }
                break;
            case "window":
                if (stream.sendCredit > UINT32_MAX - frame.creditDelta) {
                    throw this.#connectionError("Frame send credit overflow.");
                }
                stream.grantSendCredit(frame.creditDelta);
                break;
            case "fin":
                try {
                    stream.markRemoteFinished();
                } catch (error) {
                    throw this.#connectionError(normalizeError(error).message);
                }
                this.#cleanupIfClosed(stream);
                break;
            case "reset": {
                const error = new FrameResetError(frame.code, frame.message);
                this.#streams.delete(stream.id);
                this.#rejectDataJobs(stream, error);
                stream.fail(error);
                break;
            }
        }
    }

    #acceptOpenFrame(frame: Extract<Frame, { type: "open" }>): void {
        if (this.#role !== "acceptor") {
            throw this.#connectionError("Frame opener received an OPEN frame.");
        }
        if (frame.streamId <= this.#lastRemoteStreamId) {
            throw this.#connectionError(
                `Frame stream id ${frame.streamId} is not monotonic.`,
            );
        }
        if (this.#streams.has(frame.streamId)) {
            throw this.#connectionError(
                `Frame stream ${frame.streamId} is already open.`,
            );
        }
        this.#lastRemoteStreamId = frame.streamId;
        const stream = new FrameStreamState({
            host: this,
            id: frame.streamId,
            service: frame.service,
            metadata: frame.metadata,
            accepted: false,
            sendCredit: frame.receiveWindow,
            receiveCredit: 0,
        });
        this.#streams.set(stream.id, stream);
        let request: FrameOpenRequestImpl;
        request = new FrameOpenRequestImpl(
            stream,
            this.#defaultReceiveWindow,
            (window) => this.#acceptOpen(request, window),
            (code, message) => this.#rejectOpen(request, code, message),
        );
        const waiter = this.#openWaiters.shift();
        if (waiter !== undefined) waiter.resolve(request);
        else this.#pendingOpen.push(request);
    }

    #scheduleData(stream: FrameStreamState, data: Uint8Array): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.#dataJobs.push({ stream, data, resolve, reject });
            this.#pumpData();
        });
    }

    #pumpData(): void {
        if (this.#dataPumping || this.#closed) return;
        this.#dataPumping = true;
        void (async () => {
            try {
                while (!this.#closed) {
                    const job = this.#dataJobs.shift();
                    if (job === undefined) break;
                    if (this.#streams.get(job.stream.id) !== job.stream) {
                        job.reject(
                            job.stream.failure ??
                                new Error("Frame stream is closed."),
                        );
                        continue;
                    }
                    try {
                        await this.#writeFrame({
                            type: "data",
                            streamId: job.stream.id,
                            data: job.data,
                        });
                        job.resolve();
                    } catch (error) {
                        job.reject(normalizeError(error));
                    }
                    await Promise.resolve();
                }
            } finally {
                this.#dataPumping = false;
                if (this.#dataJobs.length > 0 && !this.#closed)
                    this.#pumpData();
            }
        })();
    }

    #writeFrame(frame: Frame): Promise<void> {
        this.#assertOpen();
        const encoded = encodeFrame(frame);
        const write = this.#writeTail.then(async () => {
            this.#assertOpen();
            await this.#channel.write(encoded);
        });
        this.#writeTail = write.catch(() => undefined);
        return write.catch((error) => {
            const normalized = normalizeError(error);
            this.#finish(normalized);
            throw normalized;
        });
    }

    #cleanupIfClosed(stream: FrameStreamState): void {
        if (stream.closed && this.#streams.get(stream.id) === stream) {
            this.#streams.delete(stream.id);
        }
    }

    #rejectDataJobs(stream: FrameStreamState, error: Error): void {
        for (let index = this.#dataJobs.length - 1; index >= 0; index -= 1) {
            const job = this.#dataJobs[index];
            if (job?.stream !== stream) continue;
            this.#dataJobs.splice(index, 1);
            job.reject(error);
        }
    }

    #assertCurrent(stream: FrameStreamState): void {
        this.#assertOpen();
        if (this.#streams.get(stream.id) !== stream) {
            throw stream.failure ?? new Error("Frame stream is closed.");
        }
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw this.#closeError ?? new Error("Frame protocol is closed.");
        }
    }

    #connectionError(message: string): Error {
        const error = protocolError(message);
        this.close(error);
        return error;
    }

    #finish(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#closeError = error;
        const failure = error ?? new Error("Frame channel closed.");
        for (const stream of this.#streams.values()) stream.fail(failure);
        this.#streams.clear();
        for (const job of this.#dataJobs.splice(0)) job.reject(failure);
        this.#pendingOpen.length = 0;
        for (const waiter of this.#openWaiters.splice(0)) {
            waiter.resolve(undefined);
        }
    }
}

class FrameOpenRequestImpl implements FrameOpenRequest {
    readonly stream: FrameStreamState;
    readonly #defaultReceiveWindow: number;
    readonly #accept: (receiveWindow: number) => Promise<FrameStream>;
    readonly #reset: (code: number, message: string) => Promise<void>;
    #settled = false;

    constructor(
        stream: FrameStreamState,
        defaultReceiveWindow: number,
        accept: (receiveWindow: number) => Promise<FrameStream>,
        reset: (code: number, message: string) => Promise<void>,
    ) {
        this.stream = stream;
        this.#defaultReceiveWindow = defaultReceiveWindow;
        this.#accept = accept;
        this.#reset = reset;
    }

    get streamId(): number {
        return this.stream.id;
    }

    get service(): string {
        return this.stream.service;
    }

    get metadata(): Uint8Array {
        return Uint8Array.from(this.stream.metadata);
    }

    async accept(options: FrameOpenOptions = {}): Promise<FrameStream> {
        this.#assertUnsettled();
        this.#settled = true;
        return await this.#accept(
            options.receiveWindow ?? this.#defaultReceiveWindow,
        );
    }

    async reset(
        code: number = frameResetCodes.unsupportedService,
        message = "",
    ): Promise<void> {
        this.#assertUnsettled();
        this.#settled = true;
        await this.#reset(code, message);
    }

    #assertUnsettled(): void {
        if (this.#settled)
            throw new Error("Frame open request is already settled.");
    }
}

function assertPositiveU32(value: number, label: string): void {
    if (!Number.isInteger(value) || value <= 0 || value > UINT32_MAX) {
        throw new Error(`${label} must be a positive u32.`);
    }
}

function protocolError(message: string): Error {
    return createError({
        code: "protocol.invalidFrame" as ErrorCode,
        message,
        retryable: false,
    });
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export {
    FRAME_MAX_DATA_SIZE,
    FRAME_PROTOCOL_VERSION,
    FrameBuffer,
    PacketBuffer,
    TRANSPORT_MAX_FRAME_SIZE,
    decodeFrame,
    decodePacket,
    encodeFrame,
    encodePacket,
    frameResetCodes,
} from "./Codec.js";
export type { Frame, FrameResetCode } from "./Codec.js";
export { FrameResetError } from "./Stream.js";
export type { FrameStream } from "./Stream.js";
