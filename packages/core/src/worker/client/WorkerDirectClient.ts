import type {
    InstanceName,
    JsonValue,
    ToolCallContext,
    ToolDefinition
} from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import {
    WORKER_PROTOCOL_VERSION,
    WorkerProtocolClient,
    type WorkerHandshakeResult,
    type WorkerWorkspacePrepareResult
} from "../protocol/WorkerProtocolClient.js";
import { WorkerRpcBridge } from "../rpc/WorkerRpcBridge.js";
import { WorkerRpcClient } from "../rpc/WorkerRpcClient.js";
import { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";

export interface WorkerDirectClientOptions {
    clientName?: string;
    clientVersion?: string;
    env?: NodeJS.ProcessEnv;
    instanceName: InstanceName;
    transport: WorkerCommandTransport;
}

/**
 * Thin Worker RPC client for callers that own their own lifecycle and history.
 *
 * Unlike WorkerInstance, this class has no audit database, approval store,
 * event log, scheduler, or tool-call history. It only speaks the Worker
 * protocol and validates tool inputs/outputs against the Worker catalog.
 */
export class WorkerDirectClient {
    readonly #bridge: WorkerRpcBridge;
    readonly #catalog = new WorkerToolCatalog();
    readonly #clientName: string;
    readonly #clientVersion: string;
    readonly #invoker: WorkerToolInvoker;
    readonly #protocol: WorkerProtocolClient;
    #handshake?: WorkerHandshakeResult;

    constructor(options: WorkerDirectClientOptions) {
        this.#clientName = options.clientName ?? "portable-devshell";
        this.#clientVersion = options.clientVersion ?? "0.0.0";
        this.#bridge = new WorkerRpcBridge({
            rpcOptions: {
                env: options.env,
                instanceName: options.instanceName
            },
            transport: options.transport
        });
        const rpc = new WorkerRpcClient(this.#bridge);
        this.#protocol = new WorkerProtocolClient(rpc);
        this.#invoker = new WorkerToolInvoker(rpc, this.#catalog);
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#handshake;
    }

    async connect(): Promise<WorkerHandshakeResult> {
        if (this.#handshake !== undefined) {
            return this.#handshake;
        }

        await this.#bridge.connect();
        await this.#protocol.ping();
        const handshake = await this.#protocol.handshake({
            clientName: this.#clientName,
            clientVersion: this.#clientVersion,
            maxProtocolVersion: WORKER_PROTOCOL_VERSION,
            minProtocolVersion: WORKER_PROTOCOL_VERSION
        });
        const catalog = await this.#protocol.listTools();
        this.#catalog.refresh(catalog.tools);
        this.#handshake = handshake;
        return handshake;
    }

    async prepareWorkspace(workspace: string): Promise<WorkerWorkspacePrepareResult> {
        await this.connect();
        return await this.#protocol.prepareWorkspace(workspace);
    }

    async listTools(): Promise<readonly ToolDefinition[]> {
        await this.connect();
        return this.#catalog.listTools();
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        await this.connect();
        return await this.#invoker.invoke(toolName, input, context, signal);
    }

    close(): void {
        this.#handshake = undefined;
        this.#catalog.clear();
        this.#bridge.close();
    }
}
