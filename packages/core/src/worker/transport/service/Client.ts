import type { FrameStream } from "@portable-devshell/shared/transport/frame";

import type { WorkerTransportConnection } from "../Transport.js";
import {
    encodeExecServiceMetadata,
    encodeTcpServiceMetadata,
} from "./Codec.js";
import type {
    WorkerExecProcessInput,
    WorkerTcpConnectInput,
} from "./Model.js";

export class WorkerTransportServiceClient {
    readonly #connection: WorkerTransportConnection;

    constructor(connection: WorkerTransportConnection) {
        this.#connection = connection;
    }

    async connectTcp(
        input: WorkerTcpConnectInput,
        signal?: AbortSignal,
    ): Promise<FrameStream> {
        return await this.#connection.openStream(
            "network.tcp",
            encodeTcpServiceMetadata(input),
            signal,
        );
    }

    async execProcess(
        input: WorkerExecProcessInput,
        signal?: AbortSignal,
    ): Promise<FrameStream> {
        return await this.#connection.openStream(
            "process.exec",
            encodeExecServiceMetadata(input),
            signal,
        );
    }
}
