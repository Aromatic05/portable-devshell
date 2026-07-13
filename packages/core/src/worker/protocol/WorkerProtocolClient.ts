import type { JsonValue } from "@portable-devshell/shared";

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

export interface WorkerHandshakeResult {
    instance: string;
    workspace: string;
    workerVersion: string;
    protocolVersion: number;
    platform: {
        os: string;
        arch: string;
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

    async stop(): Promise<WorkerStopResult> {
        return asObjectResult<WorkerStopResult>(await this.#rpcClient.request("worker.stop", {}));
    }
}

function asObjectResult<T>(value: JsonValue): T {
    return value as T;
}
