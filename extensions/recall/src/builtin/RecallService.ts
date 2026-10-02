import type {
    ExtensionContext,
    ExtensionJsonValue,
} from "@portable-devshell/extension";
import type {
    ExtensionContextRuntimeCapability,
    ExtensionContextRuntimeRecord,
} from "@portable-devshell/extension/context";
import type { ExtensionInstanceRuntimeCapability } from "@portable-devshell/extension/instance";

export interface RecallCallQuery {
    readonly ctxId?: string;
    readonly full?: boolean;
    readonly instance?: string;
    readonly limit?: number;
    readonly status?: string;
    readonly toolName?: string;
    readonly workspace: string;
}

export interface RecallContextQuery {
    readonly instance?: string;
    readonly workspace: string;
}

interface ToolCallProjection {
    readonly ctxId?: string;
    readonly instance?: string;
    readonly startedAt?: string;
    readonly value: ExtensionJsonValue;
}

export class RecallService {
    readonly #contexts: ExtensionContextRuntimeCapability;
    readonly #instances: ExtensionInstanceRuntimeCapability;

    constructor(context: ExtensionContext) {
        const contexts = context.capabilities.contextRuntime;
        if (contexts === undefined)
            throw new Error("Recall Extension requires contextRuntime.");
        const instances = context.capabilities.instanceRuntime;
        if (instances === undefined)
            throw new Error("Recall Extension requires instanceRuntime.");
        this.#contexts = contexts;
        this.#instances = instances;
    }

    async contexts(query: RecallContextQuery): Promise<ExtensionJsonValue> {
        const current = await this.#contexts.list({
            ...(query.instance === undefined ? {} : { instance: query.instance }),
            workspace: query.workspace,
        });
        const calls = await this.#readCallsForWorkspace(
            query.workspace,
            query.instance,
            undefined,
        );
        const merged = new Map<string, {
            createdAt?: string;
            current: boolean;
            ctxId: string;
            instances: Set<string>;
            lastAccessedAt?: string;
            lastToolCallAt?: string;
            status?: string;
            toolCalls: number;
        }>();

        for (const record of current) {
            merged.set(record.ctxId, currentContext(record));
        }
        for (const call of calls) {
            if (call.ctxId === undefined) continue;
            const existing =
                merged.get(call.ctxId) ??
                {
                    current: false,
                    ctxId: call.ctxId,
                    instances: new Set<string>(),
                    toolCalls: 0,
                };
            existing.toolCalls += 1;
            if (call.instance !== undefined) existing.instances.add(call.instance);
            if (
                call.startedAt !== undefined &&
                (existing.lastToolCallAt === undefined ||
                    call.startedAt > existing.lastToolCallAt)
            ) {
                existing.lastToolCallAt = call.startedAt;
            }
            merged.set(call.ctxId, existing);
        }

        const contexts = [...merged.values()]
            .sort((left, right) =>
                activityAt(right).localeCompare(activityAt(left)),
            )
            .map((record) => ({
                ...(record.createdAt === undefined
                    ? {}
                    : { createdAt: record.createdAt }),
                current: record.current,
                ctxId: record.ctxId,
                instances: [...record.instances].sort(),
                ...(record.lastAccessedAt === undefined
                    ? {}
                    : { lastAccessedAt: record.lastAccessedAt }),
                ...(record.lastToolCallAt === undefined
                    ? {}
                    : { lastToolCallAt: record.lastToolCallAt }),
                ...(record.status === undefined ? {} : { status: record.status }),
                toolCalls: record.toolCalls,
            }));

        return {
            contexts,
            workspace: query.workspace,
        };
    }

    async calls(query: RecallCallQuery): Promise<ExtensionJsonValue> {
        const limit = query.limit ?? 100;
        const calls = await this.#readCallsForWorkspace(
            query.workspace,
            query.instance,
            {
                ...(query.ctxId === undefined ? {} : { ctxId: query.ctxId }),
                includeInput: query.full === true,
                includeOutput: query.full === true,
                limit,
                ...(query.status === undefined ? {} : { status: query.status }),
                ...(query.toolName === undefined
                    ? {}
                    : { toolName: query.toolName }),
            },
        );
        return {
            calls: calls
                .sort((left, right) =>
                    (right.startedAt ?? "").localeCompare(left.startedAt ?? ""),
                )
                .slice(0, limit)
                .map((call) => call.value),
            workspace: query.workspace,
        };
    }

    async #readCallsForWorkspace(
        workspace: string,
        instance: string | undefined,
        query: Readonly<Record<string, ExtensionJsonValue>> | undefined,
    ): Promise<ToolCallProjection[]> {
        const instances =
            instance === undefined
                ? (await this.#instances.list())
                      .filter((record) => record.enabled)
                      .map((record) => record.name)
                : [instance];
        const batches = await Promise.all(
            instances.map(async (name) => {
                const values = await this.#instances.readToolCalls(name, {
                    ...(query ?? {
                        includeInput: false,
                        includeOutput: false,
                    }),
                    workspace,
                });
                return values.map((value) => projectToolCall(value, name));
            }),
        );
        return batches.flat();
    }
}

function currentContext(record: ExtensionContextRuntimeRecord): {
    createdAt: string;
    current: boolean;
    ctxId: string;
    instances: Set<string>;
    lastAccessedAt: string;
    status: string;
    toolCalls: number;
} {
    return {
        createdAt: record.createdAt,
        current: true,
        ctxId: record.ctxId,
        instances: new Set([
            record.instance,
            ...record.environments.map((environment) => environment.instance),
        ]),
        lastAccessedAt: record.lastAccessedAt,
        status: record.status,
        toolCalls: 0,
    };
}

function projectToolCall(
    value: ExtensionJsonValue,
    fallbackInstance: string,
): ToolCallProjection {
    const record = asRecord(value);
    return {
        ...(typeof record?.ctxId === "string" ? { ctxId: record.ctxId } : {}),
        instance:
            typeof record?.instance === "string"
                ? record.instance
                : fallbackInstance,
        ...(typeof record?.startedAt === "string"
            ? { startedAt: record.startedAt }
            : {}),
        value,
    };
}

function activityAt(record: {
    lastAccessedAt?: string;
    lastToolCallAt?: string;
}): string {
    return record.lastToolCallAt !== undefined &&
        record.lastToolCallAt > (record.lastAccessedAt ?? "")
        ? record.lastToolCallAt
        : (record.lastAccessedAt ?? "");
}

function asRecord(
    value: ExtensionJsonValue,
): Readonly<Record<string, ExtensionJsonValue>> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
