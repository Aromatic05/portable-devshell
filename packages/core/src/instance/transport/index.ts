import type { Channel } from "@portable-devshell/shared";

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
    #attached?: Channel;

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

    attach(channel: Channel): void {
        this.#attached?.close();
        this.#attached = channel;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        signal?.throwIfAborted();
        const attached = this.#attached;
        if (attached !== undefined) {
            this.#attached = undefined;
            return attached;
        }
        if (this.#connect === undefined)
            throw new Error("Worker transport connection is not attached.");
        const channel = await this.#connect();
        signal?.throwIfAborted();
        return channel;
    }

    close(error?: Error): void {
        this.#attached?.close(error);
        this.#attached = undefined;
    }
}
