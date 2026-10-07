import type { ToolCallHistoryCapability, ToolCallHistoryQuery, ToolCallHistoryRecord } from "@portable-devshell/extension/toolcall";
import type { InstanceRegistry } from "../../../../instance/Api.js";
import type { ToolCallQuery, ToolCallRecord } from "@portable-devshell/shared";

export interface ExtensionToolCallDecorator {
    decorate(instance: string, records: readonly ToolCallRecord[]): Promise<ToolCallRecord[]>;
}

export interface ExtensionToolCallHistoryCapabilityControlOptions {
    allowed: boolean;
    extensionId: string;
    instances: InstanceRegistry;
    readToolCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    toolCallDecorator?: ExtensionToolCallDecorator;
}

export class ExtensionToolCallHistoryCapabilityControl implements ToolCallHistoryCapability {
    constructor(private readonly options: ExtensionToolCallHistoryCapabilityControlOptions) {}

    async listInstances(): Promise<readonly string[]> {
        this.#assertAllowed();
        return this.options.instances.list().map((instance) => instance.config.name).sort();
    }

    async read(instance: string, query?: ToolCallHistoryQuery): Promise<readonly ToolCallHistoryRecord[]> {
        this.#assertAllowed();
        const boundedQuery = query === undefined ? undefined : {
            ...query,
            ...(query.limit === undefined ? {} : { limit: Math.max(1, Math.min(query.limit, 1_000)) }),
            ...(query.maxBytes === undefined ? {} : { maxBytes: Math.max(1, Math.min(query.maxBytes, 8 * 1024 * 1024)) }),
        };
        const records = await this.options.readToolCalls(instance, boundedQuery as ToolCallQuery | undefined);
        return this.options.toolCallDecorator === undefined
            ? records
            : await this.options.toolCallDecorator.decorate(instance, records);
    }

    #assertAllowed(): void {
        if (!this.options.allowed)
            throw new Error(`Extension ${this.options.extensionId} did not declare the toolcall.history capability.`);
    }
}
