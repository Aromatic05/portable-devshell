export interface WorkerTcpConnectInput {
    host: string;
    port: number;
}

export interface WorkerExecProcessInput {
    executable: string;
    args?: readonly string[];
    cwd?: string;
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
