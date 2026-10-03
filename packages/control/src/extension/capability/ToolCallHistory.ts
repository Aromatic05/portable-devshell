import type {
    ToolCallHistoryCapability,
    ToolCallHistoryQuery,
    ToolCallHistoryRecord,
} from "@portable-devshell/extension/toolcall";
import type { JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import type { InstanceRegistry } from "@portable-devshell/core";
import {
    limitToolCallResponse,
    readToolCallQuery,
} from "@portable-devshell/core";

export interface ExtensionToolCallDecorator {
    decorate(
        instance: string,
        records: readonly ToolCallRecord[],
    ): Promise<readonly ToolCallRecord[]>;
}

export class ExtensionToolCallHistoryCapabilityControl implements ToolCallHistoryCapability {
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #instances: InstanceRegistry;
    readonly #toolCallDecorator?: ExtensionToolCallDecorator;

    constructor(options: {
        allowed: boolean;
        extensionId: string;
        instances: InstanceRegistry;
        toolCallDecorator?: ExtensionToolCallDecorator;
    }) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#instances = options.instances;
        this.#toolCallDecorator = options.toolCallDecorator;
    }

    async listInstances(): Promise<readonly string[]> {
        this.#assertAllowed();
        return this.#instances.list().map((instance) => instance.name);
    }

    async read(
        instanceName: string,
        query: ToolCallHistoryQuery = {},
    ): Promise<readonly ToolCallHistoryRecord[]> {
        this.#assertAllowed();
        const instance = this.#require(instanceName);
        const normalized = readToolCallQuery(query as unknown as JsonValue);
        const records = await instance.worker.readToolCalls(normalized);
        const decorated =
            this.#toolCallDecorator === undefined
                ? records
                : await this.#toolCallDecorator
                      .decorate(instance.name, records)
                      .catch(() => records);
        return limitToolCallResponse([...decorated], normalized).map(
            toExtensionToolCallRecord,
        );
    }

    #require(name: string) {
        const descriptor = this.#instances.get(name);
        if (descriptor !== undefined) return descriptor;
        throw new Error(`Instance ${name} was not found or is disabled.`);
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(
            `Extension ${this.#extensionId} did not declare the toolcall.history capability.`,
        );
    }
}

function toExtensionToolCallRecord(
    record: ToolCallRecord,
): ToolCallHistoryRecord {
    return {
        callId: record.callId,
        ...(record.completedAt === undefined
            ? {}
            : { completedAt: record.completedAt }),
        ...(record.ctxId === undefined ? {} : { ctxId: record.ctxId }),
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.executionCompleted === undefined
            ? {}
            : { executionCompleted: record.executionCompleted }),
        ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
        ...(record.explanation === undefined
            ? {}
            : { explanation: record.explanation }),
        ...(record.failureStage === undefined
            ? {}
            : { failureStage: record.failureStage }),
        ...(record.input === undefined ? {} : { input: record.input }),
        inputSummary: record.inputSummary,
        instance: record.instance,
        ...(record.output === undefined ? {} : { output: record.output }),
        ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
        ...(record.requestId === undefined
            ? {}
            : { requestId: record.requestId }),
        source: record.source,
        startedAt: record.startedAt,
        status: record.status,
        ...(record.stderrBytes === undefined
            ? {}
            : { stderrBytes: record.stderrBytes }),
        ...(record.stdoutBytes === undefined
            ? {}
            : { stdoutBytes: record.stdoutBytes }),
        ...(record.termSignal === undefined
            ? {}
            : { termSignal: record.termSignal }),
        ...(record.termination === undefined
            ? {}
            : { termination: record.termination }),
        toolName: record.toolName,
        ...(record.workspace === undefined
            ? {}
            : { workspace: record.workspace }),
    };
}
