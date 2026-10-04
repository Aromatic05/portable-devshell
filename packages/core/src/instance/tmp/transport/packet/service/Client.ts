import {
    Endpoint,
    Stream,
    type MessageStream,
} from "@portable-devshell/shared";

import type {
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult,
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

    async readArtifactPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult> {
        const stream = await this.#open(
            "artifact",
            "payload.read",
            input,
            signal,
        );
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        while (true) {
            const next = await stream.readMessage();
            if (next.type === "data") {
                if (next.bytes === undefined)
                    throw new Error(
                        "Artifact payload stream returned a message chunk.",
                    );
                chunks.push(next.bytes);
                byteLength += next.bytes.byteLength;
                continue;
            }
            if (next.type !== "close")
                throw new Error(
                    "Artifact payload stream closed without metadata.",
                );
            const result = readObject(
                next.message,
                "Artifact payload stream metadata",
            );
            const returnedBytes = readInteger(
                result.returnedBytes,
                "returnedBytes",
            );
            if (returnedBytes !== byteLength)
                throw new Error(
                    "Artifact payload stream byte count is invalid.",
                );
            return {
                bytes: concat(chunks, byteLength),
                eof: readBoolean(result.eof, "eof"),
                ...(result.nextOffsetBytes == null
                    ? {}
                    : {
                          nextOffsetBytes: readInteger(
                              result.nextOffsetBytes,
                              "nextOffsetBytes",
                          ),
                      }),
                offsetBytes: readInteger(result.offsetBytes, "offsetBytes"),
                payloadId: readString(result.payloadId, "payloadId"),
                returnedBytes,
                totalBytes: readInteger(result.totalBytes, "totalBytes"),
            };
        }
    }

    async writeArtifactReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult> {
        const stream = await this.#open(
            "artifact",
            "receive.write",
            {
                offsetBytes: input.offsetBytes,
                receiveId: input.receiveId,
            },
            signal,
        );
        await stream.write(input.bytes);
        await stream.finish();
        while (true) {
            const next = await stream.readMessage();
            if (next.type === "data") continue;
            if (next.type !== "close")
                throw new Error(
                    "Artifact receive stream closed without metadata.",
                );
            const result = readObject(
                next.message,
                "Artifact receive stream metadata",
            );
            return {
                nextOffsetBytes: readInteger(
                    result.nextOffsetBytes,
                    "nextOffsetBytes",
                ),
                receivedBytes: readInteger(
                    result.receivedBytes,
                    "receivedBytes",
                ),
                receiveId: readString(result.receiveId, "receiveId"),
            };
        }
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

function concat(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
    const result = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

function readObject(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(name + " is invalid.");
    return value as Record<string, unknown>;
}

function readInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error("Artifact " + name + " is invalid.");
    return value;
}

function readString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0)
        throw new Error("Artifact " + name + " is invalid.");
    return value;
}

function readBoolean(value: unknown, name: string): boolean {
    if (typeof value !== "boolean")
        throw new Error("Artifact " + name + " is invalid.");
    return value;
}
