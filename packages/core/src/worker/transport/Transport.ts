import type { Channel } from "@portable-devshell/shared";
import {
    FRAME_PROTOCOL_RANGE,
    FRAME_PROTOCOL_VERSION,
    FrameProtocol,
    FrameResetError,
    FrameStreamChannel,
    frameResetCodes,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";

import type {
    WorkerCommandInteractiveSession,
    WorkerCommandResult,
} from "./command/Transport.js";
import type {
    WorkerChannelOptions,
    WorkerCommandName,
    WorkerCommandOptions,
} from "./command/Model.js";

const FRAME_NEGOTIATION_SERVICE = "frame.negotiate";
const frameNegotiationEncoder = new TextEncoder();
const frameNegotiationDecoder = new TextDecoder("utf-8", { fatal: true });

export interface WorkerTransport {
    connectWorkerChannel(options: WorkerChannelOptions): Promise<Channel>;
    retireProviderResources?(): Promise<void>;
    runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<WorkerCommandResult>;
    installWorker(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<void>;
}

export class WorkerTransportConnection {
    readonly #connect?: () => Promise<Channel>;
    #channel?: Channel;
    #connectPromise?: Promise<FrameProtocol>;
    #generation = 0;
    #protocol?: FrameProtocol;
    #protocolReady?: Promise<FrameProtocol>;

    constructor(connect?: () => Promise<Channel>) {
        this.#connect = connect;
    }

    static fromTransport(
        transport: WorkerTransport,
        options: WorkerChannelOptions,
    ): WorkerTransportConnection {
        return new WorkerTransportConnection(
            async () => await transport.connectWorkerChannel(options),
        );
    }

    get connected(): boolean {
        return this.#protocol?.closed === false;
    }

    attach(channel: Channel): void {
        if (this.#channel === channel && this.#protocol?.closed === false) return;
        this.close();
        const generation = this.#generation;
        this.#install(channel, generation);
    }

    detach(channel?: Channel): void {
        if (channel !== undefined && channel !== this.#channel) return;
        this.close();
    }

    async openService(service: string, signal?: AbortSignal): Promise<Channel> {
        return new FrameStreamChannel(
            await this.openStream(service, new Uint8Array(), signal),
        );
    }

    async openStream(
        service: string,
        metadata: Uint8Array = new Uint8Array(),
        signal?: AbortSignal,
    ): Promise<FrameStream> {
        throwIfAborted(signal);
        const protocol = await this.#ensureProtocol();
        throwIfAborted(signal);
        const stream = await protocol.open(service, metadata);
        if (isAborted(signal)) {
            await stream
                .reset(frameResetCodes.cancelled, abortError(signal).message)
                .catch(() => undefined);
            throw abortError(signal);
        }
        return stream;
    }

    close(error?: Error): void {
        this.#generation += 1;
        this.#connectPromise = undefined;
        this.#protocolReady = undefined;
        const protocol = this.#protocol;
        const channel = this.#channel;
        this.#protocol = undefined;
        this.#channel = undefined;
        if (protocol !== undefined) {
            protocol.close(error);
            return;
        }
        channel?.close(error);
    }

    async #ensureProtocol(): Promise<FrameProtocol> {
        if (this.#protocol?.closed === false) {
            return await this.#ensureProtocolReady(
                this.#protocol,
                this.#generation,
            );
        }
        if (this.#connectPromise === undefined) {
            if (this.#connect === undefined) {
                throw new Error("Worker transport connection is not attached.");
            }
            const generation = this.#generation;
            const connecting = this.#connect().then((channel) => {
                if (generation !== this.#generation) {
                    channel.close();
                    throw new Error("Worker transport connection was replaced.");
                }
                return this.#ensureProtocolReady(
                    this.#install(channel, generation),
                    generation,
                );
            });
            const promise = connecting.finally(() => {
                if (this.#connectPromise === promise) {
                    this.#connectPromise = undefined;
                }
            });
            this.#connectPromise = promise;
        }
        return await this.#connectPromise;
    }

    #install(channel: Channel, generation: number): FrameProtocol {
        const protocol = new FrameProtocol(channel, { role: "opener" });
        this.#channel = channel;
        this.#protocol = protocol;
        this.#protocolReady = undefined;
        channel.onClose(() => {
            if (
                this.#generation !== generation ||
                this.#channel !== channel ||
                this.#protocol !== protocol
            ) {
                return;
            }
            this.#channel = undefined;
            this.#protocol = undefined;
            this.#protocolReady = undefined;
        });
        return protocol;
    }

    #ensureProtocolReady(
        protocol: FrameProtocol,
        generation: number,
    ): Promise<FrameProtocol> {
        if (this.#protocolReady !== undefined) return this.#protocolReady;
        const ready = this.#negotiateFrameProtocol(protocol).then(() => {
            if (
                generation !== this.#generation ||
                this.#protocol !== protocol ||
                protocol.closed
            ) {
                throw new Error("Worker transport connection was replaced.");
            }
            return protocol;
        });
        this.#protocolReady = ready;
        return ready;
    }

    async #negotiateFrameProtocol(protocol: FrameProtocol): Promise<void> {
        const stream = await protocol.open(
            FRAME_NEGOTIATION_SERVICE,
            frameNegotiationEncoder.encode(
                JSON.stringify(FRAME_PROTOCOL_RANGE),
            ),
        );
        try {
            const payload = await stream.read();
            if (payload === undefined) {
                throw new Error(
                    "Frame protocol negotiation closed without selecting a version.",
                );
            }
            const trailing = await stream.read();
            if (trailing !== undefined) {
                throw new Error(
                    "Frame protocol negotiation returned more than one version frame.",
                );
            }
            const selected = frameNegotiationDecoder.decode(payload);
            if (selected !== FRAME_PROTOCOL_VERSION) {
                throw new Error(
                    `Unsupported negotiated Frame protocol version ${selected}.`,
                );
            }
            await stream.finish();
        } catch (error) {
            if (
                error instanceof FrameResetError &&
                error.resetCode === frameResetCodes.unsupportedService
            ) {
                /**
                 * @compat frame-protocol-v1-no-negotiation
                 * @removeAt 0.7.10
                 */
                return;
            }
            protocol.close(
                error instanceof Error ? error : new Error(String(error)),
            );
            throw error;
        }
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Worker transport connection was aborted.");
}

function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
    return signal?.aborted === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (isAborted(signal)) throw abortError(signal);
}
