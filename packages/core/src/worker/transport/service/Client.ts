import {
    Endpoint,
    Stream,
    type MessageStream,
} from "@portable-devshell/shared";

import type {
    WorkerExecProcessInput,
    WorkerTcpConnectInput,
} from "./Model.js";

export class WorkerTransportServiceClient {
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
        const stream = await protocol.open(name, input);
        const close = () => protocol.close();
        stream.onClose(close);
        stream.onCancel(close);
        if (signal !== undefined)
            signal.addEventListener(
                "abort",
                () => void stream.cancel({ message: String(signal.reason) }),
                { once: true },
            );
        return stream;
    }
}
