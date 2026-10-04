import {
    createPortClient,
    type ArtifactPayloadDescriptor,
    type Endpoint,
    type PortClient,
} from "@portable-devshell/shared";

export type WorkerArtifactPayloadOpenInput =
    | { expiresAtMs: number; handle: string; path?: never }
    | { expiresAtMs: number; handle?: never; path: string; workspace: string };

export interface WorkerArtifactPayloadOpenResult {
    descriptor: ArtifactPayloadDescriptor;
    expiresAtMs: number;
    payloadId: string;
}

export interface WorkerArtifactReceiveBeginInput {
    descriptor: ArtifactPayloadDescriptor;
    overwrite: boolean;
    targetPath: string;
    workspace: string;
}

export interface WorkerArtifactReceiveBeginResult {
    nextOffsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveFinishResult {
    blake3: string;
    bytes: number;
    receiveId: string;
    targetPath: string;
}

export interface WorkerArtifactDirectReceiveOpenInput {
    expiresAtMs: number;
    receiveId: string;
}

export interface WorkerArtifactDirectReceiveOpenResult {
    expiresAtMs: number;
    nextOffsetBytes: number;
    receiverId: string;
    urls: string[];
}

export interface WorkerArtifactDirectPushInput {
    maxBytes: number;
    offsetBytes: number;
    payloadId: string;
    urls: string[];
}

export interface WorkerArtifactDirectPushResult {
    nextOffsetBytes: number;
    pushedBytes: number;
}

export interface WorkerArtifactPayloadReadInput {
    maxBytes: number;
    offsetBytes: number;
    payloadId: string;
}

export interface WorkerArtifactPayloadReadResult {
    bytes: Uint8Array;
    eof: boolean;
    nextOffsetBytes?: number;
    offsetBytes: number;
    payloadId: string;
    returnedBytes: number;
    totalBytes: number;
}

export interface WorkerArtifactReceiveWriteInput {
    bytes: Uint8Array;
    offsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveWriteResult {
    nextOffsetBytes: number;
    receivedBytes: number;
    receiveId: string;
}

export class WorkerArtifact {
    readonly #port: PortClient;

    constructor(endpoint: Endpoint, workerHost: string) {
        this.#port = createPortClient(endpoint, workerHost, "artifact");
    }

    async openPayload(
        input: WorkerArtifactPayloadOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadOpenResult> {
        return await this.#port.request(
            "artifact.payload.open",
            input,
            signal,
        );
    }

    async readPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult> {
        const stream = await this.#port.open("payload.read", input, signal);
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

    async closePayload(payloadId: string): Promise<void> {
        await this.#port.request("artifact.payload.close", { payloadId });
    }

    async beginReceive(
        input: WorkerArtifactReceiveBeginInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveBeginResult> {
        return await this.#port.request(
            "artifact.receive.begin",
            input,
            signal,
        );
    }

    async writeReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult> {
        const stream = await this.#port.open(
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

    async finishReceive(
        receiveId: string,
    ): Promise<WorkerArtifactReceiveFinishResult> {
        return await this.#port.request("artifact.receive.finish", { receiveId });
    }

    async abortReceive(receiveId: string): Promise<void> {
        await this.#port.request("artifact.receive.abort", { receiveId });
    }

    async openDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactDirectReceiveOpenResult> {
        return await this.#port.request(
            "artifact.receive.direct.open",
            input,
            signal,
        );
    }

    async closeDirectReceive(receiverId: string): Promise<void> {
        await this.#port.request("artifact.receive.direct.close", { receiverId });
    }

    async pushPayloadDirect(
        input: WorkerArtifactDirectPushInput,
    ): Promise<WorkerArtifactDirectPushResult> {
        return await this.#port.request("artifact.payload.direct.push", input);
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
