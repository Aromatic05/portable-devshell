import {
    type ApprovalDecision,
    createError,
    errorCodes,
    type JsonValue,
    type ToolCallQuery,
    type ToolCallSource,
    type ToolCallStatus
} from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import type { StreamSubscriptionManager } from "../../stream/StreamSubscriptionManager.js";
import type { ControlRpcConnection, ControlRpcRelaySession } from "../../control/rpc/ControlRpcConnection.js";

const MAX_LOG_READ_LIMIT = 100;
const MAX_LOG_RESPONSE_BYTES = 1024 * 1024;
const LOG_TRUNCATION_MARKER = "\n[log output truncated]\n";

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RouteHandlerInstanceOptions {
    instanceRegistry: InstanceRegistry;
    streamSubscriptionManager: StreamSubscriptionManager;
}

export class RouteHandlerInstance {
    readonly #instanceRegistry: InstanceRegistry;
    readonly #streamSubscriptionManager: StreamSubscriptionManager;

    constructor(options: RouteHandlerInstanceOptions) {
        this.#instanceRegistry = options.instanceRegistry;
        this.#streamSubscriptionManager = options.streamSubscriptionManager;
    }

    async handle(
        connection: ControlRpcConnection,
        method: string,
        requestId: string,
        instanceName: string,
        params?: JsonValue
    ): Promise<JsonValue> {
        const descriptor = this.#instanceRegistry.get(instanceName);

        if (descriptor === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                message: `Instance ${instanceName} was not found.`,
                retryable: false,
                details: { instance: instanceName }
            });
        }

        switch (method) {
            case "instance.getSnapshot": {
                const snapshot = withTodoSummary(descriptor.worker.snapshot(), descriptor.todo.summary());
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot
                } as unknown as JsonValue;
            }
            case "instance.refreshStatus": {
                const snapshot = withTodoSummary(await descriptor.worker.refreshStatus(), descriptor.todo.summary());
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot
                } as unknown as JsonValue;
            }
            case "instance.start": {
                if (!descriptor.enabled) {
                    throw createError({
                        code: errorCodes.instanceConflict,
                        details: { instance: descriptor.name, operation: "start" },
                        message: `Instance ${descriptor.name} is disabled.`,
                        retryable: false
                    });
                }
                const result = await this.#startInteractive(
                        connection,
                        requestId,
                        descriptor.worker as unknown as {
                            startInteractive(
                                workspacePath?: string,
                                interactiveSession?: ControlStartInteractiveSession
                            ): Promise<unknown>;
                        },
                        readWorkspacePath(params)
                    );
                this.#instanceRegistry.markOwned(descriptor.name);
                return result as unknown as JsonValue;
            }
            case "instance.stop":
                return (await this.#stopInstance(descriptor)) as unknown as JsonValue;
            case "instance.readLogs":
                return limitLogResponse(await descriptor.worker.readLogs(readLogQuery(params))) as unknown as JsonValue;
            case "instance.readToolCalls":
                return (await descriptor.worker.readToolCalls(readToolCallQuery(params))) as unknown as JsonValue;
            case "instance.listApprovals":
                return (await descriptor.worker.listApprovals()) as unknown as JsonValue;
            case "instance.getApproval":
                return (await descriptor.worker.getApproval(readApprovalId(params, "instance.getApproval"))) as unknown as JsonValue;
            case "instance.decideApproval":
                return (
                    await descriptor.worker.decideApproval(readApprovalId(params, "instance.decideApproval"), {
                        ...readApprovalDecision(params),
                        decidedBy: readApprovalDecisionBy(connection, descriptor.name)
                    })
                ) as unknown as JsonValue;
            case "instance.todo.get":
                return {
                    lastSeq: descriptor.worker.snapshot().lastSeq,
                    todo: await descriptor.todo.read()
                } as unknown as JsonValue;
            case "instance.todo.subscribe":
                return await this.#streamSubscriptionManager.subscribe(
                    connection,
                    descriptor.name,
                    descriptor.worker,
                    readFromSeq(params),
                    (event) => event.type.startsWith("todo.")
                );
            case "instance.subscribe":
                return await this.#streamSubscriptionManager.subscribe(
                    connection,
                    descriptor.name,
                    descriptor.worker,
                    readFromSeq(params)
                );
            case "instance.callTool": {
                const { input, toolName } = readToolCall(params);
                return (
                    await descriptor.worker.callTool(toolName, input, {
                        requestId,
                        ctxId: connection.id,
                        source: readConnectionSource(connection, descriptor.name)
                    })
                ) as unknown as JsonValue;
            }
            default:
                throw createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Method ${method} was not found.`,
                    retryable: false
                });
        }
    }

    async #startInteractive(
        connection: ControlRpcConnection,
        requestId: string,
        worker: { startInteractive(workspacePath?: string, interactiveSession?: ControlStartInteractiveSession): Promise<unknown> },
        workspacePath?: string
    ): Promise<unknown> {
        const relay = new ControlStartRelaySession(connection, requestId);
        connection.registerRelaySession(requestId, relay);

        try {
            return await worker.startInteractive(workspacePath, relay);
        } finally {
            connection.unregisterRelaySession(requestId);
            relay.closeInput();
        }
    }

    async #stopInstance(descriptor: { enabled: boolean; name: string; worker: { stop(): Promise<unknown> } }): Promise<unknown> {
        const result = await descriptor.worker.stop();
        this.#instanceRegistry.clearOwned(descriptor.name);

        if (!descriptor.enabled) {
            this.#instanceRegistry.delete(descriptor.name);
        }

        return result;
    }
}

function withTodoSummary<T extends { lastSeq: number }>(snapshot: T, activeTodo: import("@portable-devshell/shared").ActiveTodoSummary | undefined): T & { activeTodo?: import("@portable-devshell/shared").ActiveTodoSummary } {
    return {
        ...snapshot,
        ...(activeTodo === undefined ? {} : { activeTodo })
    };
}

function readConnectionSource(connection: ControlRpcConnection, instanceName: string): ToolCallSource {
    if (connection.clientKind === "cli" || connection.clientKind === "tui" || connection.clientKind === "mcp") {
        return connection.clientKind;
    }

    throw createError({
        code: errorCodes.controlClientIdentityRequired,
        message: `Connection must identify as cli or tui before calling tools for instance ${instanceName}.`,
        retryable: false,
        details: {
            clientKind: connection.clientKind,
            instance: instanceName
        }
    });
}

function readApprovalDecisionBy(connection: ControlRpcConnection, instanceName: string): ApprovalDecision["decidedBy"] {
    if (connection.clientKind === "cli" || connection.clientKind === "tui") {
        return connection.clientKind;
    }

    throw createError({
        code: errorCodes.controlClientIdentityRequired,
        message: `Connection must identify as cli or tui before deciding approvals for instance ${instanceName}.`,
        retryable: false,
        details: {
            clientKind: connection.clientKind,
            instance: instanceName
        }
    });
}

interface ControlStartInteractiveSession {
    readInput(): Promise<Buffer | undefined>;
    writeOutput(chunk: string): Promise<void>;
}

class ControlStartRelaySession implements ControlRpcRelaySession, ControlStartInteractiveSession {
    readonly #connection: ControlRpcConnection;
    readonly #requestId: string;
    readonly #queue: Buffer[] = [];
    readonly #waiters: Array<(chunk: Buffer | undefined) => void> = [];
    #closed = false;

    constructor(connection: ControlRpcConnection, requestId: string) {
        this.#connection = connection;
        this.#requestId = requestId;
    }

    async readInput(): Promise<Buffer | undefined> {
        const chunk = this.#queue.shift();
        if (chunk !== undefined) {
            return chunk;
        }

        if (this.#closed) {
            return undefined;
        }

        return await new Promise<Buffer | undefined>((resolve) => {
            this.#waiters.push(resolve);
        });
    }

    async writeOutput(chunk: string): Promise<void> {
        if (chunk.length === 0) {
            return;
        }

        await this.#connection.sendRelayOutput(this.#requestId, chunk);
    }

    writeInput(chunk: Buffer): void {
        if (this.#closed) {
            return;
        }

        const waiter = this.#waiters.shift();
        if (waiter !== undefined) {
            waiter(chunk);
            return;
        }

        this.#queue.push(chunk);
    }

    closeInput(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        for (const waiter of this.#waiters.splice(0)) {
            waiter(undefined);
        }
    }
}

function readWorkspacePath(params?: JsonValue): string | undefined {
    if (!isRecord(params) || params.workspacePath === undefined) {
        return undefined;
    }

    return typeof params.workspacePath === "string" ? params.workspacePath : undefined;
}

function readLogQuery(params?: JsonValue): { fromSeq?: number; limit?: number } {
    const limit = isRecord(params) && typeof params.limit === "number" && Number.isInteger(params.limit)
        ? Math.min(Math.max(params.limit, 1), MAX_LOG_READ_LIMIT)
        : MAX_LOG_READ_LIMIT;

    return {
        fromSeq: isRecord(params) && typeof params.fromSeq === "number" ? params.fromSeq : undefined,
        limit
    };
}

function limitLogResponse<TLog extends { message: string }>(logs: TLog[]): TLog[] {
    const response: TLog[] = [];
    let responseBytes = 2;

    for (const log of logs) {
        const separatorBytes = response.length === 0 ? 0 : 1;
        const logBytes = Buffer.byteLength(JSON.stringify(log), "utf8");

        if (responseBytes + separatorBytes + logBytes <= MAX_LOG_RESPONSE_BYTES) {
            response.push(log);
            responseBytes += separatorBytes + logBytes;
            continue;
        }

        const compactLog = {
            ...log,
            message: truncateLogMessage(log, MAX_LOG_RESPONSE_BYTES - responseBytes - separatorBytes)
        };
        const compactLogBytes = Buffer.byteLength(JSON.stringify(compactLog), "utf8");

        if (responseBytes + separatorBytes + compactLogBytes <= MAX_LOG_RESPONSE_BYTES) {
            response.push(compactLog);
        }

        return response;
    }

    return response;
}

function truncateLogMessage<TLog extends { message: string }>(log: TLog, availableBytes: number): string {
    if (Buffer.byteLength(JSON.stringify({ ...log, message: LOG_TRUNCATION_MARKER }), "utf8") > availableBytes) {
        return LOG_TRUNCATION_MARKER;
    }

    let start = 0;
    let end = log.message.length;

    while (start < end) {
        const middle = Math.floor((start + end) / 2);
        const message = `${LOG_TRUNCATION_MARKER}${log.message.slice(middle)}`;

        if (Buffer.byteLength(JSON.stringify({ ...log, message }), "utf8") <= availableBytes) {
            end = middle;
        } else {
            start = middle + 1;
        }
    }

    return `${LOG_TRUNCATION_MARKER}${log.message.slice(start)}`;
}

function readFromSeq(params?: JsonValue): number {
    if (!isRecord(params) || typeof params.fromSeq !== "number") {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "instance.subscribe requires numeric fromSeq.",
            retryable: false
        });
    }

    return params.fromSeq;
}

function readToolCall(params?: JsonValue): { input: JsonValue; toolName: string } {
    if (!isRecord(params) || typeof params.toolName !== "string") {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "instance.callTool requires toolName.",
            retryable: false
        });
    }

    return {
        input: params.input ?? null,
        toolName: params.toolName
    };
}

function readApprovalId(params: JsonValue | undefined, method: string): string {
    if (!isRecord(params) || typeof params.approvalId !== "string") {
        throw createError({
            code: errorCodes.targetInvalid,
            message: `${method} requires approvalId.`,
            retryable: false
        });
    }

    return params.approvalId;
}

function readApprovalDecision(
    params?: JsonValue
): { decision: ApprovalDecision["decision"]; policyPatch?: JsonValue; reason?: string; remember?: boolean } {
    if (!isRecord(params) || (params.decision !== "approve" && params.decision !== "deny")) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "instance.decideApproval requires decision to be approve or deny.",
            retryable: false
        });
    }

    return {
        decision: params.decision,
        ...(params.policyPatch === undefined ? {} : { policyPatch: params.policyPatch }),
        ...(params.reason === undefined
            ? {}
            : typeof params.reason === "string"
              ? { reason: params.reason }
              : failToolCallQuery("instance.decideApproval requires string reason.")),
        ...(params.remember === undefined
            ? {}
            : typeof params.remember === "boolean"
              ? { remember: params.remember }
              : failToolCallQuery("instance.decideApproval requires boolean remember."))
    };
}

function readToolCallQuery(params?: JsonValue): ToolCallQuery {
    if (!isRecord(params)) {
        return {};
    }

    if (params.after !== undefined && typeof params.after !== "string") {
        throw invalidToolCallQuery("instance.readToolCalls requires string after.");
    }

    if (params.before !== undefined && typeof params.before !== "string") {
        throw invalidToolCallQuery("instance.readToolCalls requires string before.");
    }

    if (params.limit !== undefined && typeof params.limit !== "number") {
        throw invalidToolCallQuery("instance.readToolCalls requires numeric limit.");
    }

    return {
        ...(params.after === undefined ? {} : { after: params.after }),
        ...(params.before === undefined ? {} : { before: params.before }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.source === undefined ? {} : { source: readToolCallSource(params.source) }),
        ...(params.status === undefined ? {} : { status: readToolCallStatus(params.status) }),
        ...(params.toolName === undefined
            ? {}
            : typeof params.toolName === "string"
              ? { toolName: params.toolName }
              : failToolCallQuery("instance.readToolCalls requires string toolName."))
    };
}

function readToolCallSource(value: JsonValue): ToolCallSource {
    if (value === "cli" || value === "tui" || value === "mcp") {
        return value;
    }

    throw invalidToolCallQuery("instance.readToolCalls requires source to be cli, tui, or mcp.");
}

function readToolCallStatus(value: JsonValue): ToolCallStatus {
    if (
        value === "pendingApproval" ||
        value === "running" ||
        value === "completed" ||
        value === "failed" ||
        value === "denied" ||
        value === "expired"
    ) {
        return value;
    }

    throw invalidToolCallQuery("instance.readToolCalls requires status to be pendingApproval, running, completed, failed, denied, or expired.");
}

function invalidToolCallQuery(message: string) {
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false
    });
}

function failToolCallQuery(message: string): never {
    throw invalidToolCallQuery(message);
}
