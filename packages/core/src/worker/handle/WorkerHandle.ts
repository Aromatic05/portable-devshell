import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";

import type { WorkerProtocolClient, WorkerWorkspacePrepareResult } from "../protocol/WorkerProtocolClient.js";
import type { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import type { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";

export interface WorkerHandleOptions {
    assertReady(): void;
    catalog: WorkerToolCatalog;
    isReady(): boolean;
    protocolClient: WorkerProtocolClient;
    toolInvoker: WorkerToolInvoker;
}

/**
 * Non-owning capability handle for one managed Worker instance.
 *
 * The handle shares the WorkerInstance connection regardless of whether the
 * underlying endpoint is controller-managed or reverse-connected. Consumers
 * may bind any absolute workspace per call. The handle does not own Worker
 * lifecycle and does not add approval, audit, scheduling, or tool history.
 */
export class WorkerHandle {
    readonly #assertReady: () => void;
    readonly #catalog: WorkerToolCatalog;
    readonly #isReady: () => boolean;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: WorkerHandleOptions) {
        this.#assertReady = options.assertReady;
        this.#catalog = options.catalog;
        this.#isReady = options.isReady;
        this.#protocolClient = options.protocolClient;
        this.#toolInvoker = options.toolInvoker;
    }

    listTools(): readonly ToolDefinition[] {
        this.#assertReady();
        return this.#catalog.listTools();
    }

    async prepareWorkspace(workspace: string): Promise<WorkerWorkspacePrepareResult> {
        this.#assertReady();
        return await this.#protocolClient.prepareWorkspace(workspace);
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        onProgress?: (progress: JsonValue) => void
    ): Promise<JsonValue> {
        this.#assertReady();
        return await this.#toolInvoker.invoke(toolName, input, context, signal, onProgress);
    }

    async releaseToolSession(sessionId: string): Promise<void> {
        if (!this.#isReady()) return;
        await this.#protocolClient.closeToolSession(sessionId).catch(() => undefined);
    }
}
