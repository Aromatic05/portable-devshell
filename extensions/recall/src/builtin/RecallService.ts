import type { ExtensionContext } from "@portable-devshell/extension";
import type {
    ExtensionContextObserveCapability,
    ExtensionContextRecord,
    ExtensionContextStatus,
} from "@portable-devshell/extension/context";
import type {
    ToolCallHistoryCapability,
    ToolCallHistoryRecord,
    ToolCallStatus,
} from "@portable-devshell/extension/toolcall";

const CONTEXT_SCAN_PAGE_LIMIT = 500;
const CONTEXT_SCAN_MAX_CALLS_PER_INSTANCE = 5_000;
const CONTEXT_SCAN_MAX_BYTES = 512 * 1024;
const CALL_READ_MAX_BYTES = 8 * 1024 * 1024;

export interface RecallCallQuery {
    readonly ctxId?: string;
    readonly full?: boolean;
    readonly instance?: string;
    readonly limit?: number;
    readonly status?: ToolCallStatus;
    readonly toolName?: string;
    readonly workspace: string;
}

export interface RecallContextQuery {
    readonly instance?: string;
    readonly workspace: string;
}

export interface RecallIssue {
    readonly instance: string;
    readonly message: string;
}

export interface RecallContextEntry {
    readonly createdAt?: string;
    readonly ctxId: string;
    readonly instances: readonly string[];
    readonly lastAccessedAt?: string;
    readonly lastToolCallAt?: string;
    readonly origin: "context-registry" | "tool-call-history";
    readonly status: ExtensionContextStatus | "history-only";
    readonly toolCalls: number;
}

export interface RecallContextsResult {
    readonly contexts: readonly RecallContextEntry[];
    readonly issues: readonly RecallIssue[];
    readonly truncatedInstances: readonly string[];
    readonly workspace: string;
}

export interface RecallCallsResult {
    readonly calls: readonly ToolCallHistoryRecord[];
    readonly issues: readonly RecallIssue[];
    readonly workspace: string;
}

interface MutableContextEntry {
    createdAt?: string;
    ctxId: string;
    instances: Set<string>;
    lastAccessedAt?: string;
    lastToolCallAt?: string;
    origin: "context-registry" | "tool-call-history";
    status: ExtensionContextStatus | "history-only";
    toolCalls: number;
}

interface ReadCallsResult {
    calls: ToolCallHistoryRecord[];
    issues: RecallIssue[];
    truncatedInstances: string[];
}

export class RecallService {
    readonly #contexts: ExtensionContextObserveCapability;
    readonly #history: ToolCallHistoryCapability;

    constructor(context: ExtensionContext) {
        const contexts = context.capabilities.contextObserve;
        if (contexts === undefined)
            throw new Error("Recall Extension requires contextObserve.");
        const history = context.capabilities.toolCallHistory;
        if (history === undefined)
            throw new Error("Recall Extension requires toolCallHistory.");
        this.#contexts = contexts;
        this.#history = history;
    }

    async contexts(query: RecallContextQuery): Promise<RecallContextsResult> {
        const current = await this.#contexts.list({
            ...(query.instance === undefined ? {} : { instance: query.instance }),
            workspace: query.workspace,
        });
        const history = await this.#readContextHistory(
            query.workspace,
            query.instance,
        );
        const merged = new Map<string, MutableContextEntry>();

        for (const record of current) {
            merged.set(record.ctxId, retainedContext(record));
        }
        for (const call of history.calls) {
            if (call.ctxId === undefined) continue;
            const existing =
                merged.get(call.ctxId) ?? historyContext(call.ctxId);
            existing.toolCalls += 1;
            existing.instances.add(call.instance);
            if (
                existing.lastToolCallAt === undefined ||
                call.startedAt > existing.lastToolCallAt
            ) {
                existing.lastToolCallAt = call.startedAt;
            }
            merged.set(call.ctxId, existing);
        }

        return {
            contexts: [...merged.values()]
                .sort((left, right) =>
                    activityAt(right).localeCompare(activityAt(left)),
                )
                .map((record) => ({
                    ...(record.createdAt === undefined
                        ? {}
                        : { createdAt: record.createdAt }),
                    ctxId: record.ctxId,
                    instances: [...record.instances].sort(),
                    ...(record.lastAccessedAt === undefined
                        ? {}
                        : { lastAccessedAt: record.lastAccessedAt }),
                    ...(record.lastToolCallAt === undefined
                        ? {}
                        : { lastToolCallAt: record.lastToolCallAt }),
                    origin: record.origin,
                    status: record.status,
                    toolCalls: record.toolCalls,
                })),
            issues: history.issues,
            truncatedInstances: history.truncatedInstances,
            workspace: query.workspace,
        };
    }

    async calls(query: RecallCallQuery): Promise<RecallCallsResult> {
        const limit = query.limit ?? 100;
        const history = await this.#readAcrossInstances(
            query.instance,
            async (instance) =>
                await this.#history.read(instance, {
                    ...(query.ctxId === undefined ? {} : { ctxId: query.ctxId }),
                    includeInput: query.full === true,
                    includeOutput: query.full === true,
                    limit,
                    maxBytes: CALL_READ_MAX_BYTES,
                    ...(query.status === undefined
                        ? {}
                        : { status: query.status }),
                    ...(query.toolName === undefined
                        ? {}
                        : { toolName: query.toolName }),
                    workspace: query.workspace,
                }),
        );
        return {
            calls: history.calls
                .sort((left, right) =>
                    right.startedAt.localeCompare(left.startedAt),
                )
                .slice(0, limit),
            issues: history.issues,
            workspace: query.workspace,
        };
    }

    async #readContextHistory(
        workspace: string,
        instance: string | undefined,
    ): Promise<ReadCallsResult> {
        return await this.#readAcrossInstances(instance, async (name) => {
            const records: ToolCallHistoryRecord[] = [];
            let before: string | undefined;
            while (records.length <= CONTEXT_SCAN_MAX_CALLS_PER_INSTANCE) {
                const remaining =
                    CONTEXT_SCAN_MAX_CALLS_PER_INSTANCE + 1 - records.length;
                const page = await this.#history.read(name, {
                    ...(before === undefined ? {} : { before }),
                    includeInput: false,
                    includeOutput: false,
                    limit: Math.min(CONTEXT_SCAN_PAGE_LIMIT, remaining),
                    maxBytes: CONTEXT_SCAN_MAX_BYTES,
                    workspace,
                });
                if (page.length === 0) break;
                records.unshift(...page);
                before = page[0]!.callId;
            }
            return records;
        }, true);
    }

    async #readAcrossInstances(
        instance: string | undefined,
        read: (
            instance: string,
        ) => Promise<readonly ToolCallHistoryRecord[]>,
        markTruncation = false,
    ): Promise<ReadCallsResult> {
        const instances =
            instance === undefined
                ? [...(await this.#history.listInstances())]
                : [instance];
        const settled = await Promise.allSettled(
            instances.map(async (name) => ({
                name,
                records: await read(name),
            })),
        );
        const calls: ToolCallHistoryRecord[] = [];
        const issues: RecallIssue[] = [];
        const truncatedInstances: string[] = [];
        for (let index = 0; index < settled.length; index += 1) {
            const result = settled[index]!;
            const name = instances[index]!;
            if (result.status === "rejected") {
                issues.push({
                    instance: name,
                    message: errorMessage(result.reason),
                });
                continue;
            }
            const instanceRecords =
                markTruncation &&
                result.value.records.length > CONTEXT_SCAN_MAX_CALLS_PER_INSTANCE
                    ? result.value.records.slice(
                          -CONTEXT_SCAN_MAX_CALLS_PER_INSTANCE,
                      )
                    : result.value.records;
            calls.push(...instanceRecords);
            if (
                markTruncation &&
                result.value.records.length > CONTEXT_SCAN_MAX_CALLS_PER_INSTANCE
            ) {
                truncatedInstances.push(name);
            }
        }
        return { calls, issues, truncatedInstances };
    }
}

function retainedContext(
    record: ExtensionContextRecord,
): MutableContextEntry {
    return {
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        instances: new Set(
            record.environments.map((environment) => environment.instance),
        ),
        lastAccessedAt: record.lastAccessedAt,
        origin: "context-registry",
        status: record.status,
        toolCalls: 0,
    };
}

function historyContext(ctxId: string): MutableContextEntry {
    return {
        ctxId,
        instances: new Set<string>(),
        origin: "tool-call-history",
        status: "history-only",
        toolCalls: 0,
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
