import type { Channel } from "@portable-devshell/shared";
import {
    FrameProtocol,
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
        if (this.#protocol?.closed === false) return this.#protocol;
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
                return this.#install(channel, generation);
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
        });
        return protocol;
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
