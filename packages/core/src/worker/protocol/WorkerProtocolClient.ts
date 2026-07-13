import type { ArtifactPayloadDescriptor, JsonValue } from "@portable-devshell/shared";

import { WorkerRpcClient } from "../rpc/WorkerRpcClient.js";

export interface WorkerHandshakeParams {
    minProtocolVersion: number;
    maxProtocolVersion: number;
    clientName: string;
    clientVersion: string;
}

export interface WorkerPingResult {
    pong: boolean;
}
export interface WorkerStopResult {
    stopping: boolean;
}

export interface WorkerShellRuntime {
    executable: string;
    kind: "bash" | "powershell" | string;
    version: string;
}

export interface WorkerHandshakeResult {
    instance: string;
    workspace: string;
    workerVersion: string;
    protocolVersion: number;
    platform: {
        os: string;
        arch: string;
        shell?: WorkerShellRuntime;
    };
    capabilities: {
        tools: boolean;
        streaming: boolean;
        cancel: boolean;
    };
}

export interface WorkerToolDefinition {
    requiredCapabilities: readonly ("read" | "write" | "execute")[];
    name: string;
    description: string;
    group: string;
    inputSchema: JsonValue;
    outputSchema: JsonValue;
}

export interface WorkerToolsListResult {
    tools: WorkerToolDefinition[];
}

export type WorkerArtifactPayloadOpenInput =
    | { expiresAtMs: number; handle: string; path?: never }
    | { expiresAtMs: number; handle?: never; path: string };

export interface WorkerArtifactPayloadOpenResult {
    descriptor: ArtifactPayloadDescriptor;
    expiresAtMs: number;
    payloadId: string;
}

export interface WorkerArtifactPayloadReadInput {
    maxBytes: number;
    offsetBytes: number;
    payloadId: string;
}

export interface WorkerArtifactPayloadReadResult {
    content: string;
    encoding: "base64";
    eof: boolean;
    nextOffsetBytes?: number;
    offsetBytes: number;
    payloadId: string;
    returnedBytes: number;
    totalBytes: number;
}

export interface WorkerArtifactReceiveBeginInput {
    descriptor: ArtifactPayloadDescriptor;
    overwrite: boolean;
    targetPath: string;
}

export interface WorkerArtifactReceiveBeginResult {
    nextOffsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveWriteInput {
    content: string;
    offsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveWriteResult {
    nextOffsetBytes: number;
    receivedBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveFinishResult {
    blake3: string;
    bytes: number;
    receiveId: string;
    targetPath: string;
}

export class WorkerProtocolClient {
    readonly #rpcClient: WorkerRpcClient;

    constructor(rpcClient: WorkerRpcClient) {
        this.#rpcClient = rpcClient;
    }

    async ping(): Promise<WorkerPingResult> {
        return asObjectResult<WorkerPingResult>(await this.#rpcClient.request("worker.ping", {}));
    }

    async handshake(params: WorkerHandshakeParams): Promise<WorkerHandshakeResult> {
        return asObjectResult<WorkerHandshakeResult>(
            await this.#rpcClient.request("worker.handshake", params as unknown as JsonValue)
        );
    }

    async listTools(): Promise<WorkerToolsListResult> {
        return asObjectResult<WorkerToolsListResult>(await this.#rpcClient.request("tools.list", {}));
    }

    async openArtifactPayload(input: WorkerArtifactPayloadOpenInput): Promise<WorkerArtifactPayloadOpenResult> {
        return asObjectResult<WorkerArtifactPayloadOpenResult>(
            await this.#rpcClient.request("artifact.payload.open", input as unknown as JsonValue)
        );
    }

    async readArtifactPayload(input: WorkerArtifactPayloadReadInput): Promise<WorkerArtifactPayloadReadResult> {
        return asObjectResult<WorkerArtifactPayloadReadResult>(
            await this.#rpcClient.request("artifact.payload.read", input as unknown as JsonValue)
        );
    }

    async closeArtifactPayload(payloadId: string): Promise<void> {
        await this.#rpcClient.request("artifact.payload.close", { payloadId });
    }

    async beginArtifactReceive(input: WorkerArtifactReceiveBeginInput): Promise<WorkerArtifactReceiveBeginResult> {
        return asObjectResult<WorkerArtifactReceiveBeginResult>(
            await this.#rpcClient.request("artifact.receive.begin", input as unknown as JsonValue)
        );
    }

    async writeArtifactReceive(input: WorkerArtifactReceiveWriteInput): Promise<WorkerArtifactReceiveWriteResult> {
        return asObjectResult<WorkerArtifactReceiveWriteResult>(
            await this.#rpcClient.request("artifact.receive.write", input as unknown as JsonValue)
        );
    }

    async finishArtifactReceive(receiveId: string): Promise<WorkerArtifactReceiveFinishResult> {
        return asObjectResult<WorkerArtifactReceiveFinishResult>(
            await this.#rpcClient.request("artifact.receive.finish", { receiveId })
        );
    }

    async abortArtifactReceive(receiveId: string): Promise<void> {
        await this.#rpcClient.request("artifact.receive.abort", { receiveId });
    }

    async stop(): Promise<WorkerStopResult> {
        return asObjectResult<WorkerStopResult>(await this.#rpcClient.request("worker.stop", {}));
    }
}

function asObjectResult<T>(value: JsonValue): T {
    return value as T;
}
