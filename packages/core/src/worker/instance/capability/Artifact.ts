import type {
    WorkerArtifactDirectPushInput,
    WorkerArtifactDirectPushResult,
    WorkerArtifactDirectReceiveOpenInput,
    WorkerArtifactDirectReceiveOpenResult,
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult,
    WorkerProtocolClient,
} from "../../protocol/Client.js";
import {
    frameResetCodes,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";
import type { WorkerTransportConnection } from "../../transport/Transport.js";

const ARTIFACT_PAYLOAD_HEADER_BYTES = 8;
const CANONICAL_BASE64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface WorkerInstanceArtifactOptions {
    assertReady(): void;
    protocolClient: WorkerProtocolClient;
    transportConnection: Pick<WorkerTransportConnection, "openStream">;
}

export class WorkerInstanceArtifact {
    readonly #assertReady: WorkerInstanceArtifactOptions["assertReady"];
    readonly #protocolClient: WorkerProtocolClient;
    readonly #transportConnection: WorkerInstanceArtifactOptions["transportConnection"];

    constructor(options: WorkerInstanceArtifactOptions) {
        this.#assertReady = options.assertReady;
        this.#protocolClient = options.protocolClient;
        this.#transportConnection = options.transportConnection;
    }

    async openPayload(
        input: WorkerArtifactPayloadOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadOpenResult> {
        this.#assertReady();
        return await this.#protocolClient.openArtifactPayload(input, signal);
    }

    async readPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult> {
        this.#assertReady();
        const stream = await this.#transportConnection.openStream(
            "artifact.payload",
            encodeMetadata(input),
            signal,
        );
        return await useFrameStream(stream, signal, async () => {
            await stream.finish();
            const response = await readStreamBytes(
                stream,
                input.maxBytes + ARTIFACT_PAYLOAD_HEADER_BYTES,
            );
            if (response.byteLength < ARTIFACT_PAYLOAD_HEADER_BYTES) {
                throw new Error("Artifact payload service returned a truncated header.");
            }
            const totalBigInt = response.readBigUInt64BE(0);
            if (totalBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error("Artifact payload length exceeds the safe integer range.");
            }
            const totalBytes = Number(totalBigInt);
            const content = response.subarray(ARTIFACT_PAYLOAD_HEADER_BYTES);
            const nextOffsetBytes = input.offsetBytes + content.byteLength;
            if (
                !Number.isSafeInteger(nextOffsetBytes) ||
                input.offsetBytes < 0 ||
                nextOffsetBytes > totalBytes
            ) {
                throw new Error("Artifact payload service returned an invalid byte range.");
            }
            const eof = nextOffsetBytes >= totalBytes;
            return {
                content: content.toString("base64"),
                encoding: "base64",
                eof,
                ...(eof ? {} : { nextOffsetBytes }),
                offsetBytes: input.offsetBytes,
                payloadId: input.payloadId,
                returnedBytes: content.byteLength,
                totalBytes,
            };
        });
    }

    async closePayload(payloadId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.closeArtifactPayload(payloadId);
    }

    async beginReceive(
        input: WorkerArtifactReceiveBeginInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveBeginResult> {
        this.#assertReady();
        return await this.#protocolClient.beginArtifactReceive(input, signal);
    }

    async writeReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult> {
        this.#assertReady();
        const content = decodeBase64(input.content);
        const stream = await this.#transportConnection.openStream(
            "artifact.receive",
            encodeMetadata({
                offsetBytes: input.offsetBytes,
                receiveId: input.receiveId,
            }),
            signal,
        );
        return await useFrameStream(stream, signal, async () => {
            if (content.byteLength > 0) {
                await stream.write(content);
            }
            await stream.finish();
            const unexpected = await stream.read();
            if (unexpected !== undefined) {
                throw new Error("Artifact receive service returned unexpected DATA.");
            }
            const nextOffsetBytes = input.offsetBytes + content.byteLength;
            if (!Number.isSafeInteger(nextOffsetBytes)) {
                throw new Error("Artifact receive offset exceeds the safe integer range.");
            }
            return {
                nextOffsetBytes,
                receivedBytes: nextOffsetBytes,
                receiveId: input.receiveId,
            };
        });
    }

    async finishReceive(
        receiveId: string,
    ): Promise<WorkerArtifactReceiveFinishResult> {
        this.#assertReady();
        return await this.#protocolClient.finishArtifactReceive(receiveId);
    }

    async abortReceive(receiveId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.abortArtifactReceive(receiveId);
    }

    async openDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactDirectReceiveOpenResult> {
        this.#assertReady();
        return await this.#protocolClient.openArtifactDirectReceive(
            input,
            signal,
        );
    }

    async closeDirectReceive(receiverId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.closeArtifactDirectReceive(receiverId);
    }

    async pushPayloadDirect(
        input: WorkerArtifactDirectPushInput,
    ): Promise<WorkerArtifactDirectPushResult> {
        this.#assertReady();
        return await this.#protocolClient.pushArtifactPayloadDirect(input);
    }
}

function encodeMetadata(value: object): Uint8Array {
    return Buffer.from(JSON.stringify(value), "utf8");
}

function decodeBase64(value: string): Buffer {
    if (!CANONICAL_BASE64.test(value)) {
        throw new Error("Artifact receive content must be canonical base64.");
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) {
        throw new Error("Artifact receive content must be canonical base64.");
    }
    return decoded;
}

async function readStreamBytes(
    stream: FrameStream,
    maximumBytes: number,
): Promise<Buffer> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
        throw new Error("Artifact payload maximum byte count is invalid.");
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (true) {
        const chunk = await stream.read();
        if (chunk === undefined) break;
        byteLength += chunk.byteLength;
        if (byteLength > maximumBytes) {
            throw new Error("Artifact payload service exceeded the requested byte count.");
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, byteLength);
}

async function useFrameStream<T>(
    stream: FrameStream,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    const abort = () => {
        void stream
            .reset(frameResetCodes.cancelled, abortError(signal!).message)
            .catch(() => undefined);
    };
    if (isAborted(signal)) {
        abort();
        throw abortError(signal!);
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const result = await operation();
        if (isAborted(signal)) throw abortError(signal!);
        return result;
    } catch (error) {
        if (!stream.closed) {
            await stream
                .reset(frameResetCodes.cancelled, asError(error).message)
                .catch(() => undefined);
        }
        if (isAborted(signal)) throw abortError(signal!);
        throw error;
    } finally {
        signal?.removeEventListener("abort", abort);
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Artifact transfer was aborted.");
}

function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
