import {
    createPortClient,
    type Endpoint,
    type WorkerArtifactApi,
} from "@portable-devshell/shared";



























export function createWorkerArtifact(
    endpoint: Endpoint,
    workerHost: string,
): WorkerArtifactApi {
    const port = createPortClient(endpoint, workerHost, "artifact");
    return {
        openArtifactPayload: async (input, signal) =>
            await port.request(
                "artifact.payload.open",
                input,
                signal,
            ),
        readArtifactPayload: async (input, signal) => {
            const stream = await port.open("payload.read", input, signal);
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
        },
        closeArtifactPayload: async (payloadId) => {
            await port.request("artifact.payload.close", { payloadId });
        },
        beginArtifactReceive: async (input, signal) =>
            await port.request(
                "artifact.receive.begin",
                input,
                signal,
            ),
        writeArtifactReceive: async (input, signal) => {
            const stream = await port.open(
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
        },
        finishArtifactReceive: async (receiveId) =>
            await port.request("artifact.receive.finish", { receiveId }),
        abortArtifactReceive: async (receiveId) => {
            await port.request("artifact.receive.abort", { receiveId });
        },
        openArtifactDirectReceive: async (input, signal) =>
            await port.request(
                "artifact.receive.direct.open",
                input,
                signal,
            ),
        closeArtifactDirectReceive: async (receiverId) => {
            await port.request("artifact.receive.direct.close", { receiverId });
        },
        pushArtifactPayloadDirect: async (input) =>
            await port.request("artifact.payload.direct.push", input),
    };
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
