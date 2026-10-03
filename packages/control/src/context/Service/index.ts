import type { ContextChangeHub } from "../Registry/Change.js";
import type { ContextSnapshot } from "../../../../shared/src/workspace/context/Revision.js";
import type {
    ContextLifecycleCleanupPort,
    ContextPresentationPort,
} from "./Cleanup.js";
export type { ContextPresentationPort } from "./Cleanup.js";
import { type WorkerInstanceLike } from "@portable-devshell/mcp";
import type {
    ContextRegistryPort,
    McpContextRecord,
} from "@portable-devshell/shared";
import type {
    ContextEnvironmentPort,
} from "@portable-devshell/mcp";

export interface ContextRecordSourcePort extends ContextRegistryPort {
    readonly changes: ContextChangeHub;
    snapshot(): Promise<ContextSnapshot>;
}

export class ContextService {
    readonly registry: ContextRecordSourcePort;
    readonly environment: ContextEnvironmentPort;
    readonly cleanup: ContextLifecycleCleanupPort;
    readonly #worker: (instance: string) => WorkerInstanceLike | undefined;
    #presentation?: ContextPresentationPort;

    constructor(options: {
        registry: ContextRecordSourcePort;
        environment: ContextEnvironmentPort;
        cleanup: ContextLifecycleCleanupPort;
        worker(instance: string): WorkerInstanceLike | undefined;
    }) {
        this.registry = options.registry;
        this.environment = options.environment;
        this.cleanup = options.cleanup;
        this.#worker = options.worker;
    }

    bindPresentation(presentation: ContextPresentationPort): void {
        this.#presentation = presentation;
        this.cleanup.bindPresentation(presentation);
    }

    async initialize(): Promise<void> {
        await this.registry.initialize();
    }

    async reconcile(): Promise<void> {
        await this.cleanup.reconcile();
    }

    async disable(ctxId: string): Promise<McpContextRecord> {
        const record = await this.registry.disable(ctxId);
        await this.cleanup.terminate(record);
        return record;
    }

    async renew(ctxId: string): Promise<McpContextRecord> {
        const record = await this.registry.renew(ctxId);
        for (const environment of record.environments) {
            if (environment.workspace === undefined) continue;
            const worker = this.#worker(environment.instance);
            if (worker?.snapshot().ready === true) {
                await worker.touchAlerts?.(environment.workspace);
            }
        }
        return record;
    }

    async detachInstance(instance: string): Promise<McpContextRecord[]> {
        const affected = await this.registry.detachInstance(instance);
        await this.#presentation?.revokeInstance(instance);
        return affected;
    }


}
