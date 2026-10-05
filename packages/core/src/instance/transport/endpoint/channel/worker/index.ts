import { ChannelBase, type Channel, type CommandResult, type PortClient } from "@portable-devshell/shared";
import type { ChannelCommandOptions, CommandOptions } from "./Command.js";

export interface WorkerConnection {
    runCommand(operation: string, command: readonly string[], options?: CommandOptions): Promise<CommandResult>;
    openChannel(operation: string, command: readonly string[], options?: ChannelCommandOptions): Promise<WorkerChannel>;
}

export interface WorkerChannel<Connection = WorkerConnection | PortClient> extends Channel {
    getConnection(): Connection;
}

export class Worker<Connection = WorkerConnection | PortClient> extends ChannelBase implements WorkerChannel<Connection> {
    #channel?: Channel;
    readonly #connection: Connection;
    #unsubscribeData?: () => void;
    #unsubscribeClose?: () => void;

    constructor(connection: Connection) {
        super();
        this.#connection = connection;
    }

    get connected(): boolean {
        return this.#channel !== undefined && !this.closed;
    }

    attach(channel: Channel): void {
        if (this.closed || this.#channel !== undefined) {
            channel.close();
            throw new Error("Worker channel cannot attach another communication resource.");
        }
        this.#channel = channel;
        this.#unsubscribeData = channel.onData(data => this.emitData(data));
        this.#unsubscribeClose = channel.onClose(error => this.close(error));
    }

    getConnection(): Connection {
        return this.#connection;
    }

    write(data: Uint8Array): Promise<void> {
        if (this.closed) return Promise.reject(this.closeError("Worker channel is closed."));
        if (this.#channel === undefined) return Promise.reject(new Error("Worker channel is not connected."));
        return this.#channel.write(data);
    }

    close(error?: Error): void {
        if (this.closed) return;
        this.#unsubscribeData?.();
        this.#unsubscribeClose?.();
        this.#channel?.close(error);
        this.finish(error);
    }
}
