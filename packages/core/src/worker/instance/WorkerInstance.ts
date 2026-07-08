import { randomUUID } from "node:crypto";

import {
    asWorkspacePath,
    createError,
    errorCodes,
    type CommandResult,
    type JsonValue,
    type ToolCallContext,
    type ToolCallRecord,
    type WorkspacePath
} from "@portable-devshell/shared";

import type { EventStreamGap, EventStreamSlice, InstanceEventInput } from "../../log/LogEventBuffer.js";
import { InstanceEventBuffer } from "../../log/LogEventBuffer.js";
import type { LogQuery } from "../../log/LogQuery.js";
import type { InstanceLogEntry } from "../../log/store/LogStoreInstance.js";
import { InstanceLogStore } from "../../log/store/LogStoreInstance.js";
import { InstanceBusyError, ToolCallHistory } from "../../log/LogToolCallHistory.js";
import { WorkerCommandClient } from "../../worker/command/WorkerCommandClient.js";
import { WorkerProtocolClient, type WorkerHandshakeResult } from "../../worker/protocol/WorkerProtocolClient.js";
import { WorkerRpcBridge } from "../../worker/rpc/WorkerRpcBridge.js";
import { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import { InstanceStateMachine } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";

interface WorkerInstanceDependencies {
    catalog: WorkerToolCatalog;
    commandClient: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    eventBuffer: InstanceEventBuffer;
    logStore: InstanceLogStore;
    protocolClient: WorkerProtocolClient;
    rpcBridge: WorkerRpcBridge;
    stateMachine: InstanceStateMachine;
    toolCallHistory: ToolCallHistory;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstance {
    readonly #catalog: WorkerToolCatalog;
    readonly #commandClient: WorkerCommandClient;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #eventBuffer: InstanceEventBuffer;
    readonly #logStore: InstanceLogStore;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #rpcBridge: WorkerRpcBridge;
    readonly #stateMachine: InstanceStateMachine;
    readonly #toolCallHistory: ToolCallHistory;
    readonly #toolInvoker: WorkerToolInvoker;
    #handshake?: WorkerHandshakeResult;
    #intentionalRpcCloseDepth = 0;
    #reconnectPromise?: Promise<InstanceSnapshot>;
    #workspacePath?: WorkspacePath;

    constructor(dependencies: WorkerInstanceDependencies) {
        this.#catalog = dependencies.catalog;
        this.#commandClient = dependencies.commandClient;
        this.#config = dependencies.config;
        this.#eventBuffer = dependencies.eventBuffer;
        this.#logStore = dependencies.logStore;
        this.#protocolClient = dependencies.protocolClient;
        this.#rpcBridge = dependencies.rpcBridge;
        this.#stateMachine = dependencies.stateMachine;
        this.#toolCallHistory = dependencies.toolCallHistory;
        this.#toolInvoker = dependencies.toolInvoker;
        this.#rpcBridge.onDisconnect((error) => {
            void this.#handleRpcDisconnect(error);
        });
    }

    snapshot(): InstanceSnapshot {
        return this.#stateMachine.snapshot();
    }

    listTools() {
        return this.#catalog.listTools();
    }

    hasToolSchemaCache(): boolean {
        return this.#catalog.hasSchema();
    }

    async start(workspacePath?: WorkspacePath | string): Promise<InstanceSnapshot> {
        const resolvedWorkspacePath = workspacePath ?? this.#config.defaultWorkspace;

        if (resolvedWorkspacePath === undefined) {
            throw createError({
                code: errorCodes.coreWorkerStartFailed,
                message: `Instance ${this.#config.name} requires a workspace to start.`,
                retryable: false,
                details: { instanceName: this.#config.name }
            });
        }

        this.#workspacePath = asWorkspacePath(resolvedWorkspacePath);
        this.#stateMachine.apply({
            connectionState: "disconnected",
            daemonState: "starting",
            lastErrorCode: undefined
        });

        try {
            const startResult = await this.#commandClient.start(resolvedWorkspacePath);

            if (startResult.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreWorkerStartFailed,
                    message: `Worker start failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: {
                        exitCode: startResult.exitCode,
                        instanceName: this.#config.name,
                        stderr: startResult.stderr,
                        stdout: startResult.stdout
                    }
                });
            }
        } catch (error) {
            this.#stateMachine.apply({
                connectionState: "disconnected",
                daemonState: "stopped",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerStartFailed)
            });
            throw error;
        }

        this.#stateMachine.apply({ connectionState: "connecting" });

        try {
            await this.#rpcBridge.connect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(this.#config.handshake);
            const tools = await this.#protocolClient.listTools();
            this.#catalog.refresh(tools.tools);
            const startedEvent = await this.#appendEvent("instance.started", {
                workspace: this.#handshake.workspace,
                workerVersion: this.#handshake.workerVersion
            });

            this.#stateMachine.apply({
                daemonState: "running",
                lastErrorCode: undefined,
                lastSeq: startedEvent.seq
            });
            return this.#stateMachine.apply({
                connectionState: "connected",
                lastSeq: startedEvent.seq
            });
        } catch (error) {
            this.#closeRpcBridge();
            this.#stateMachine.apply({
                connectionState: "disconnected",
                daemonState: "running",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerHandshakeFailed)
            });

            if (isKnownErrorCode(error)) {
                throw error;
            }

            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: {
                    instanceName: this.#config.name,
                    reason: error instanceof Error ? error.message : String(error)
                }
            });
        }
    }

    async stop(): Promise<InstanceSnapshot> {
        let stopErrorCode: string | undefined;

        try {
            const result = await this.#commandClient.stop();

            if (result.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreWorkerStopFailed,
                    message: `Worker stop failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: {
                        exitCode: result.exitCode,
                        instanceName: this.#config.name,
                        stderr: result.stderr,
                        stdout: result.stdout
                    }
                });
            }
        } catch (error) {
            stopErrorCode = getErrorCode(error, errorCodes.coreWorkerStopFailed);
            this.#stateMachine.apply({
                connectionState: "disconnected",
                daemonState: "stopping",
                lastErrorCode: stopErrorCode
            });
            throw error;
        } finally {
            this.#closeRpcBridge();
            this.#handshake = undefined;
        }

        const stoppedEvent = await this.#appendEvent("instance.stopped");
        this.#stateMachine.apply({
            daemonState: "stopped",
            lastErrorCode: stopErrorCode,
            lastSeq: stoppedEvent.seq
        });
        return this.#stateMachine.apply({
            connectionState: "disconnected",
            lastErrorCode: undefined,
            lastSeq: stoppedEvent.seq
        });
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        const status = await this.#readWorkerStatus();

        if (status.workspacePath !== undefined) {
            this.#workspacePath = asWorkspacePath(status.workspacePath);
        }

        switch (status.daemonState) {
            case "stopped":
            case "stale":
                this.#closeRpcBridge();
                this.#handshake = undefined;
                return this.#stateMachine.apply({
                    connectionState: "disconnected",
                    daemonState: status.daemonState,
                    lastErrorCode: undefined,
                    pid: status.pid
                });
            case "running":
                return await this.#refreshRunningStatus(status.pid);
            default:
                return this.#stateMachine.apply({
                    connectionState: "failed",
                    daemonState: "failed",
                    lastErrorCode: errorCodes.coreWorkerStatusFailed,
                    pid: status.pid
                });
        }
    }

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext): Promise<CommandResult> {
        if (!this.snapshot().ready) {
            throw createError({
                code: errorCodes.coreInstanceNotReady,
                message: `Instance ${this.#config.name} is not ready.`,
                retryable: false,
                details: { instanceName: this.#config.name }
            });
        }

        const callId = randomUUID();
        const startedAt = new Date().toISOString();

        try {
            await this.#toolCallHistory.started(callId, toolName, toHistoryArgs(input), context, startedAt);
        } catch (error) {
            if (error instanceof InstanceBusyError) {
                throw createError({
                    code: errorCodes.coreInstanceBusy,
                    message: error.message,
                    retryable: false,
                    details: { instanceName: this.#config.name, toolName }
                });
            }

            throw error;
        }

        await this.#appendEvent(
            "toolCall.started",
            toEventData({
                callId,
                requestId: context.requestId,
                sessionId: context.sessionId,
                source: context.source,
                toolName
            })
        );

        try {
            const result = await this.#toolInvoker.invoke(toolName, input);
            await this.#appendToolLogs(result);
            await this.#toolCallHistory.completed(callId, result, new Date().toISOString());
            await this.#appendEvent(
                "toolCall.completed",
                toEventData({
                    callId,
                    exitCode: result.exitCode,
                    requestId: context.requestId,
                    sessionId: context.sessionId,
                    source: context.source,
                    toolName
                })
            );
            return result;
        } catch (error) {
            const finishedAt = new Date().toISOString();
            const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);
            const result = asCommandResult(error);

            await this.#toolCallHistory.failed(callId, errorCode, finishedAt, result);
            await this.#appendEvent(
                "toolCall.failed",
                toEventData({
                    callId,
                    errorCode,
                    requestId: context.requestId,
                    sessionId: context.sessionId,
                    source: context.source,
                    toolName
                })
            );
            throw error;
        }
    }

    async readLogs(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        return await this.#logStore.read(query);
    }

    async readToolCalls(query: LogQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#toolCallHistory.read(query);
    }

    subscribe(fromSeq = 1): EventStreamGap | EventStreamSlice {
        return this.#eventBuffer.readFrom(fromSeq);
    }

    close(): void {
        this.#closeRpcBridge();
        this.#handshake = undefined;
        this.#stateMachine.apply({
            connectionState: "disconnected",
            lastErrorCode: undefined
        });
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#handshake;
    }

    get workspacePath(): WorkspacePath | undefined {
        return this.#workspacePath;
    }

    async reconnectRpc(): Promise<InstanceSnapshot> {
        if (this.#reconnectPromise !== undefined) {
            return await this.#reconnectPromise;
        }

        this.#reconnectPromise = this.#refreshRunningStatus(this.snapshot().pid, "reconnecting", true).finally(() => {
            this.#reconnectPromise = undefined;
        });
        return await this.#reconnectPromise;
    }

    async #refreshRunningStatus(
        pid?: number,
        connectionState: "connecting" | "reconnecting" = this.snapshot().connectionState === "disconnected" ? "connecting" : "reconnecting",
        emitReconnectEvents = false
    ): Promise<InstanceSnapshot> {
        this.#stateMachine.apply({
            connectionState,
            daemonState: "running",
            lastErrorCode: undefined,
            pid
        });

        try {
            await this.#rpcBridge.connect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(this.#config.handshake);
            const tools = await this.#protocolClient.listTools();
            const refreshedTools = this.#catalog.refresh(tools.tools);
            this.#workspacePath = asWorkspacePath(this.#handshake.workspace);
            let lastSeq = this.snapshot().lastSeq;

            if (emitReconnectEvents) {
                const connectedEvent = await this.#appendEvent("worker.rpcConnected");
                const schemaEvent = await this.#appendEvent(
                    "worker.schemaRefreshed",
                    toEventData({ toolCount: refreshedTools.length })
                );
                lastSeq = Math.max(connectedEvent.seq, schemaEvent.seq);
            }

            return this.#stateMachine.apply({
                connectionState: "connected",
                daemonState: "running",
                lastErrorCode: undefined,
                lastSeq,
                pid
            });
        } catch (error) {
            this.#closeRpcBridge();
            this.#handshake = undefined;
            this.#stateMachine.apply({
                connectionState: "failed",
                daemonState: "running",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerHandshakeFailed),
                pid
            });

            if (isKnownErrorCode(error)) {
                throw error;
            }

            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: {
                    instanceName: this.#config.name,
                    reason: error instanceof Error ? error.message : String(error)
                }
            });
        }
    }

    async #readWorkerStatus(): Promise<{
        daemonState: "running" | "stale" | "stopped";
        pid?: number;
        workspacePath?: string;
    }> {
        let result: Awaited<ReturnType<WorkerCommandClient["status"]>>;

        try {
            result = await this.#commandClient.status();
        } catch (error) {
            this.#stateMachine.apply({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerStatusFailed)
            });
            throw error;
        }

        if (result.exitCode !== 0) {
            const error = createError({
                code: errorCodes.coreWorkerStatusFailed,
                message: `Worker status failed for instance ${this.#config.name}.`,
                retryable: false,
                details: {
                    exitCode: result.exitCode,
                    instanceName: this.#config.name,
                    stderr: result.stderr,
                    stdout: result.stdout
                }
            });
            this.#stateMachine.apply({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: error.code
            });
            throw error;
        }

        return parseWorkerStatus(result.stdout, this.#config.name);
    }

    async #handleRpcDisconnect(error: unknown): Promise<void> {
        if (this.#intentionalRpcCloseDepth > 0) {
            return;
        }

        const daemonState = this.snapshot().daemonState;
        const disconnectedEvent = await this.#appendEvent(
            "worker.rpcDisconnected",
            toEventData({ errorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected) })
        );

        this.#handshake = undefined;
        this.#stateMachine.apply({
            connectionState: daemonState === "running" ? "reconnecting" : "disconnected",
            daemonState,
            lastErrorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected),
            lastSeq: disconnectedEvent.seq
        });

        if (daemonState !== "running") {
            return;
        }

        try {
            await this.reconnectRpc();
        } catch {}
    }

    #closeRpcBridge(): void {
        this.#intentionalRpcCloseDepth += 1;

        try {
            this.#rpcBridge.close();
        } finally {
            this.#intentionalRpcCloseDepth -= 1;
        }
    }

    async #appendEvent(type: InstanceEventInput["type"], data?: JsonValue) {
        return await this.#eventBuffer.append({
            at: new Date().toISOString(),
            data,
            type
        });
    }

    async #appendToolLogs(result: CommandResult): Promise<void> {
        const at = new Date().toISOString();

        if (result.stdout.length > 0) {
            await this.#logStore.append("stdout", result.stdout, at);
        }

        if (result.stderr.length > 0) {
            await this.#logStore.append("stderr", result.stderr, at);
        }
    }
}

function toHistoryArgs(input: JsonValue): string[] {
    if (Array.isArray(input)) {
        return input.map((value) => JSON.stringify(value) ?? "null");
    }

    if (typeof input === "object" && input !== null) {
        return [JSON.stringify(input)];
    }

    return [String(input)];
}

function asCommandResult(error: unknown): CommandResult | undefined {
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        return undefined;
    }

    const candidate = error as Record<string, unknown>;

    if (
        typeof candidate.stdout !== "string" ||
        typeof candidate.stderr !== "string" ||
        (typeof candidate.exitCode !== "number" && candidate.exitCode !== null)
    ) {
        return undefined;
    }

    return {
        exitCode: candidate.exitCode as number | null,
        signal: typeof candidate.signal === "string" ? candidate.signal : undefined,
        stderr: candidate.stderr,
        stdout: candidate.stdout,
        timedOut: candidate.timedOut === true
    };
}

function getErrorCode(error: unknown, fallback: string): string {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
        return error.code;
    }

    return fallback;
}

function isKnownErrorCode(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

function toEventData(
    record: Record<string, JsonValue | undefined>
): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
}

function parseWorkerStatus(
    stdout: string,
    instanceName: string
): {
    daemonState: "running" | "stale" | "stopped";
    pid?: number;
    workspacePath?: string;
} {
    const parsed = JSON.parse(stdout) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            message: `Worker status returned an invalid payload for instance ${instanceName}.`,
            retryable: false
        });
    }

    const candidate = parsed as Record<string, unknown>;
    const state = candidate.state;

    if (state !== "running" && state !== "stale" && state !== "stopped") {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            message: `Worker status returned an unknown state for instance ${instanceName}.`,
            retryable: false,
            details: { state: String(state) }
        });
    }

    return {
        daemonState: state,
        pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
        workspacePath: typeof candidate.workspace === "string" ? candidate.workspace : undefined
    };
}
