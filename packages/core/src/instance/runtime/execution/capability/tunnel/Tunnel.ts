import type { WorkerTcpConnectInput, WorkerExecProcessInput } from "../../../../Api.js";
import {
    Endpoint,
    Stream,
    type MessageStream,
} from "@portable-devshell/shared";





export class WorkerTunnel {
    readonly #endpoint: Endpoint;
    readonly #workerHost: string;

    constructor(endpoint: Endpoint, workerHost: string) {
        this.#endpoint = endpoint;
        this.#workerHost = workerHost;
    }

    connectTcp(
        input: WorkerTcpConnectInput,
        signal?: AbortSignal,
    ): Promise<MessageStream> {
        return this.#open("network", "tcp", input, signal);
    }

    execProcess(
        input: WorkerExecProcessInput,
        signal?: AbortSignal,
    ): Promise<MessageStream> {
        return this.#open("process", "exec", input, signal);
    }

    async #open(
        port: string,
        name: string,
        input: object,
        signal?: AbortSignal,
    ): Promise<MessageStream> {
        const protocol = new Stream(
            await this.#endpoint.connect(this.#workerHost, port, signal),
        );
        let stream: MessageStream;
        try {
            stream = await protocol.open(name, input, signal);
        } catch (error) {
            protocol.close();
            throw error;
        }
        const close = () => protocol.close();
        stream.onClose(close);
        stream.onCancel(close);
        return stream;
    }
}
