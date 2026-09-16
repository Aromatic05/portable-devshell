import type { Channel } from "@portable-devshell/shared";
import {
    FrameProtocol,
    FrameStreamChannel,
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

export async function connectWorkerService(
    transport: WorkerTransport,
    options: WorkerChannelOptions,
    service: string,
    signal?: AbortSignal,
): Promise<Channel> {
    throwIfAborted(signal);
    const transportChannel = await transport.connectWorkerChannel(options);
    if (isAborted(signal)) {
        transportChannel.close();
        throw abortError(signal);
    }

    return await openWorkerService(transportChannel, service, signal);
}

export async function openWorkerService(
    transportChannel: Channel,
    service: string,
    signal?: AbortSignal,
): Promise<Channel> {
    throwIfAborted(signal);

    const protocol = new FrameProtocol(transportChannel, { role: "opener" });
    try {
        const stream = await protocol.open(service);
        if (isAborted(signal)) {
            protocol.close();
            throw abortError(signal);
        }
        return new FrameStreamChannel(stream, {
            closeTransport: (error) => protocol.close(error),
        });
    } catch (error) {
        protocol.close(
            error instanceof Error ? error : new Error(String(error)),
        );
        if (isAborted(signal)) throw abortError(signal);
        throw error;
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
