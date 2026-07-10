import { randomUUID } from "node:crypto";

import {
    type ApprovalDecision,
    type ApprovalRequest,
    asWorkspacePath,
    createError,
    errorCodes,
    type CommandDiagnostic,
    type CommandResult,
    type JsonValue,
    type ToolCallContext,
    type ToolCallApprovalDecision,
    type ToolCallQuery,
    type ToolCallRecord,
    type WorkspacePath
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../../approval/ApprovalInfra.js";
import type { EventStreamGap, EventStreamSlice, InstanceEventInput } from "../../log/LogEventBuffer.js";
import { InstanceEventBuffer } from "../../log/LogEventBuffer.js";
import type { LogQuery } from "../../log/LogQuery.js";
import type { InstanceLogEntry } from "../../log/store/LogStoreInstance.js";
import { InstanceLogStore } from "../../log/store/LogStoreInstance.js";
import { InstanceBusyError, ToolCallHistory } from "../../log/LogToolCallHistory.js";
import { WorkerCommandClient } from "../../worker/command/WorkerCommandClient.js";
import type { WorkerCommandInteractiveSession } from "../../worker/command/WorkerCommandTransport.js";
import { WorkerProtocolClient, type WorkerHandshakeResult } from "../../worker/protocol/WorkerProtocolClient.js";
import { WorkerRpcBridge } from "../../worker/rpc/WorkerRpcBridge.js";
import { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import { InstanceStateMachine, type InstanceStateUpdate } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";

interface WorkerInstanceDependencies {
    approvalManager: ApprovalManager;
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
    readonly #approvalManager: ApprovalManager;
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
        this.#approvalManager = dependencies.approvalManager;
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
        return {
            ...this.#stateMachine.snapshot(),
            effectiveSecurityMode: this.#config.effectiveSecurityMode
        };
    }

    listTools() {
        return this.#catalog.listTools();
    }

    hasToolSchemaCache(): boolean {
        return this.#catalog.hasSchema();
    }

    async start(workspacePath?: WorkspacePath | string): Promise<InstanceSnapshot> {
        return await this.#start(workspacePath);
    }

    async startInteractive(
        workspacePath: WorkerCommandInteractiveSession | WorkspacePath | string | undefined,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<InstanceSnapshot> {
        return await this.#start(
            isInteractiveSession(workspacePath) ? undefined : workspacePath,
            isInteractiveSession(workspacePath) ? workspacePath : interactiveSession
        );
    }

    async #start(
        workspacePath?: WorkspacePath | string,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<InstanceSnapshot> {
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
        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "starting",
            lastErrorCode: undefined
        });

        try {
            const startResult = await this.#commandClient.start(resolvedWorkspacePath, interactiveSession);

            if (startResult.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreWorkerStartFailed,
                    message: `Worker start failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(withInstanceDetails(startResult.details, this.#config.name))
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStartFailed,
                `Worker start failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopped",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStartFailed)
            });
            throw wrappedError;
        }

        await this.#applyStateUpdate({ connectionState: "connecting" });

        try {
            await this.#rpcBridge.connect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(this.#config.handshake);
            const tools = await this.#protocolClient.listTools();
            const refreshedTools = this.#catalog.refresh(tools.tools);
            await this.#appendEvent("worker.rpcConnected");
            await this.#appendEvent(
                "worker.schemaRefreshed",
                toEventData({ toolCount: refreshedTools.length })
            );
            await this.#appendEvent("instance.started", {
                workspace: this.#handshake.workspace,
                workerVersion: this.#handshake.workerVersion
            });

            await this.#applyStateUpdate({
                daemonState: "running",
                lastErrorCode: undefined
            });
            return await this.#applyStateUpdate({
                connectionState: "connected",
            });
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerHandshakeFailed,
                `Worker handshake failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            this.#closeRpcBridge();
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "running",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerHandshakeFailed)
            });

            if (wrappedError !== error) {
                throw wrappedError;
            }

            if (isKnownErrorCode(error)) {
                throw error;
            }

            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
                cause: error,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: { instance: this.#config.name }
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
                    details: toJsonDetails(withInstanceDetails(result.details, this.#config.name))
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStopFailed,
                `Worker stop failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            stopErrorCode = getErrorCode(error, errorCodes.coreWorkerStopFailed);
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopping",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStopFailed)
            });
            throw wrappedError;
        } finally {
            this.#closeRpcBridge();
            this.#handshake = undefined;
        }

        await this.#appendEvent("instance.stopped");
        await this.#applyStateUpdate({
            daemonState: "stopped",
            lastErrorCode: stopErrorCode
        });
        return await this.#applyStateUpdate({
            connectionState: "disconnected",
            lastErrorCode: undefined
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
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: status.daemonState,
                    lastErrorCode: undefined,
                    pid: status.pid
                });
            case "running":
                return await this.#refreshRunningStatus(status.pid);
            default:
                return await this.#applyStateUpdate({
                    connectionState: "failed",
                    daemonState: "failed",
                    lastErrorCode: errorCodes.coreWorkerStatusFailed,
                    pid: status.pid
                });
        }
    }

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
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
        const inputSummary = toInputSummary(input);
        const eventContext = {
            callId,
            requestId: context.requestId,
            sessionId: context.sessionId,
            source: context.source,
            toolName
        } as const;

        try {
            await this.#toolCallHistory.started(callId, toolName, inputSummary, context, startedAt);
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
                ...eventContext,
                startedAt,
                status: "started"
            })
        );

        const approvalState = await this.#prepareToolCallApproval(callId, toolName, inputSummary, context, startedAt);
        const runningContext = {
            ...eventContext,
            ...(approvalState.approvalId === undefined ? {} : { approvalId: approvalState.approvalId })
        };

        await this.#appendEvent(
            "toolCall.running",
            toEventData({
                ...runningContext,
                ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                startedAt,
                status: "running"
            })
        );

        try {
            const result = await this.#toolInvoker.invoke(toolName, input);
            const bashResult = toolName === "bash_run" ? asBashToolResult(result) : undefined;
            const completedAt = new Date().toISOString();
            if (bashResult !== undefined) {
                await this.#appendToolLogs(bashResult, runningContext);
            }
            await this.#toolCallHistory.completed(
                callId,
                completedAt,
                bashResult === undefined ? undefined : {
                    exitCode: bashResult.exitCode,
                    stderrBytes: bashResult.stderrBytes,
                    stdoutBytes: bashResult.stdoutBytes,
                    termSignal: bashResult.termSignal,
                    termination: bashResult.termination
                }
            );
            await this.#appendEvent(
                "toolCall.completed",
                toEventData({
                    ...runningContext,
                    completedAt,
                    ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                    exitCode: bashResult?.exitCode,
                    startedAt,
                    status: "completed",
                    stderrBytes: bashResult?.stderrBytes,
                    stdoutBytes: bashResult?.stdoutBytes,
                    termSignal: bashResult?.termSignal,
                    termination: bashResult?.termination
                })
            );
            return result;
        } catch (error) {
            const finishedAt = new Date().toISOString();
            const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);
            const result = asCommandResult(error);

            if (result !== undefined) {
                await this.#appendToolLogs(result, runningContext);
            }
            await this.#toolCallHistory.failed(
                callId,
                errorCode,
                finishedAt,
                result === undefined
                    ? undefined
                    : {
                          exitCode: result.exitCode,
                          stderrBytes: readByteLength(result.stderr),
                          stdoutBytes: readByteLength(result.stdout)
                      }
            );
            await this.#appendEvent(
                "toolCall.failed",
                toEventData({
                    ...runningContext,
                    completedAt: finishedAt,
                    ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                    errorCode,
                    exitCode: result?.exitCode,
                    startedAt,
                    status: "failed",
                    stderrBytes: result === undefined ? undefined : readByteLength(result.stderr),
                    stdoutBytes: result === undefined ? undefined : readByteLength(result.stdout)
                })
            );
            throw error;
        }
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        return await this.#approvalManager.listApprovals();
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        return await this.#approvalManager.getApproval(approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: { decision: ApprovalDecision["decision"]; decidedBy: ApprovalDecision["decidedBy"]; policyPatch?: JsonValue; reason?: string; remember?: boolean }
    ): Promise<ApprovalRequest> {
        return await this.#approvalManager.decideApproval(approvalId, input);
    }

    async readLogs(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        return await this.#logStore.read(query);
    }

    async readToolCalls(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#toolCallHistory.read(query);
    }

    reconfigure(input: {
        approvalPolicy?: ResolvedWorkerInstanceConfig["approvalPolicy"];
        defaultWorkspace?: WorkspacePath;
        effectiveSecurityMode: ResolvedWorkerInstanceConfig["effectiveSecurityMode"];
        env?: NodeJS.ProcessEnv;
    }): void {
        this.#config.approvalPolicy = input.approvalPolicy;
        this.#config.defaultWorkspace = input.defaultWorkspace;
        this.#config.effectiveSecurityMode = input.effectiveSecurityMode;
        this.#config.env = input.env;
        this.#approvalManager.setPolicy(input.approvalPolicy);
    }

    async appendMcpSessionOpened(sessionId: string): Promise<void> {
        await this.#appendEvent("mcp.sessionOpened", toEventData({ sessionId }));
    }

    async appendMcpSessionClosed(sessionId: string): Promise<void> {
        await this.#appendEvent("mcp.sessionClosed", toEventData({ sessionId }));
    }

    async appendMcpToolCalled(toolName: string, context: { requestId?: string; sessionId?: string }): Promise<void> {
        await this.#appendEvent(
            "mcp.toolCalled",
            toEventData({
                requestId: context.requestId,
                sessionId: context.sessionId,
                source: "mcp",
                toolName
            })
        );
    }

    subscribe(fromSeq = 1): EventStreamGap | EventStreamSlice {
        return this.#eventBuffer.readFrom(fromSeq);
    }

    async close(): Promise<void> {
        this.#closeRpcBridge();
        this.#handshake = undefined;
        await this.#applyStateUpdate({
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

        this.#reconnectPromise = this.#refreshRunningStatus(this.snapshot().pid, "reconnecting").finally(() => {
            this.#reconnectPromise = undefined;
        });
        return await this.#reconnectPromise;
    }

    async #refreshRunningStatus(
        pid?: number,
        connectionState: "connecting" | "reconnecting" = this.snapshot().connectionState === "disconnected" ? "connecting" : "reconnecting"
    ): Promise<InstanceSnapshot> {
        const shouldEmitRpcLifecycleEvents = this.snapshot().connectionState !== "connected";

        await this.#applyStateUpdate({
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

            if (shouldEmitRpcLifecycleEvents) {
                await this.#appendEvent("worker.rpcConnected");
                await this.#appendEvent(
                    "worker.schemaRefreshed",
                    toEventData({ toolCount: refreshedTools.length })
                );
            }

            return await this.#applyStateUpdate({
                connectionState: "connected",
                daemonState: "running",
                lastErrorCode: undefined,
                pid
            });
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerHandshakeFailed,
                `Worker handshake failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            this.#closeRpcBridge();
            this.#handshake = undefined;
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "running",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerHandshakeFailed),
                pid
            });

            if (wrappedError !== error) {
                throw wrappedError;
            }

            if (isKnownErrorCode(error)) {
                throw error;
            }

            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
                cause: error,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: { instance: this.#config.name }
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
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStatusFailed,
                `Worker status failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStatusFailed)
            });
            throw wrappedError;
        }

        if (result.exitCode !== 0) {
            const error = createError({
                code: errorCodes.coreWorkerStatusFailed,
                message: `Worker status failed for instance ${this.#config.name}.`,
                retryable: false,
                details: toJsonDetails(withInstanceDetails(result.details, this.#config.name))
            });
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: error.code
            });
            throw error;
        }

        try {
            return parseWorkerStatus(result.stdout, this.#config.name);
        } catch (error) {
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerStatusFailed)
            });
            throw error;
        }
    }

    async #handleRpcDisconnect(error: unknown): Promise<void> {
        if (this.#intentionalRpcCloseDepth > 0) {
            return;
        }

        const daemonState = this.snapshot().daemonState;
        await this.#appendEvent(
            "worker.rpcDisconnected",
            toEventData({ errorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected) })
        );

        this.#handshake = undefined;
        await this.#applyStateUpdate({
            connectionState: daemonState === "running" ? "reconnecting" : "disconnected",
            daemonState,
            lastErrorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected)
        });

        if (daemonState !== "running") {
            return;
        }

        try {
            await this.reconnectRpc();
        } catch {
            return;
        }
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
        const event = await this.#eventBuffer.append({
            at: new Date().toISOString(),
            data,
            type
        });
        this.#stateMachine.apply({ lastSeq: event.seq });
        return event;
    }

    async #prepareToolCallApproval(
        callId: string,
        toolName: string,
        inputSummary: string,
        context: ToolCallContext,
        startedAt: string
    ): Promise<{ approvalId?: string; decision?: ToolCallApprovalDecision }> {
        let evaluation: Awaited<ReturnType<ApprovalManager["evaluate"]>>;

        try {
            evaluation = await this.#approvalManager.evaluate({
                callId,
                context,
                inputSummary,
                toolName
            });
        } catch (error) {
            return await this.#failToolCallBeforeInvoke(callId, toolName, context, startedAt, error);
        }

        if (evaluation.decision === "allow") {
            await this.#toolCallHistory.running(callId);
            return {};
        }

        if (evaluation.decision === "deny") {
            return await this.#denyToolCall(callId, toolName, context, startedAt, evaluation.error);
        }

        await this.#toolCallHistory.pendingApproval(callId, evaluation.request.approvalId);
        await this.#appendEvent("approval.requested", toApprovalEventData(evaluation.request));
        await this.#appendEvent(
            "toolCall.pendingApproval",
            toEventData({
                approvalId: evaluation.request.approvalId,
                callId,
                createdAt: evaluation.request.createdAt,
                expiresAt: evaluation.request.expiresAt,
                inputSummary,
                reason: evaluation.request.reason,
                requestId: context.requestId,
                riskLevel: evaluation.request.riskLevel,
                sessionId: context.sessionId,
                source: context.source,
                startedAt,
                status: "pendingApproval",
                toolName
            })
        );

        const resolution = await evaluation.awaitDecision;

        if (resolution.status === "approved") {
            const approvedRequest = await this.#approvalManager.getApproval(evaluation.request.approvalId);
            await this.#toolCallHistory.running(callId, "approved");
            await this.#appendEvent("approval.approved", toApprovalEventData(approvedRequest, resolution.decision));
            return {
                approvalId: evaluation.request.approvalId,
                decision: "approved"
            };
        }

        if (resolution.status === "denied") {
            const deniedRequest = await this.#approvalManager.getApproval(evaluation.request.approvalId);
            await this.#appendEvent("approval.denied", toApprovalEventData(deniedRequest, resolution.decision));
            return await this.#denyToolCall(callId, toolName, context, startedAt, resolution.error, evaluation.request.approvalId);
        }

        const expiredRequest = await this.#approvalManager.getApproval(evaluation.request.approvalId);
        await this.#appendEvent("approval.expired", toApprovalEventData(expiredRequest));
        return await this.#expireToolCall(callId, toolName, context, startedAt, resolution.error, evaluation.request.approvalId);
    }

    async #failToolCallBeforeInvoke(
        callId: string,
        toolName: string,
        context: ToolCallContext,
        startedAt: string,
        error: unknown
    ): Promise<never> {
        const completedAt = new Date().toISOString();
        const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);

        await this.#toolCallHistory.failed(callId, errorCode, completedAt);
        await this.#appendEvent(
            "toolCall.failed",
            toEventData({
                callId,
                completedAt,
                errorCode,
                requestId: context.requestId,
                sessionId: context.sessionId,
                source: context.source,
                startedAt,
                status: "failed",
                toolName
            })
        );

        throw error;
    }

    async #denyToolCall(
        callId: string,
        toolName: string,
        context: ToolCallContext,
        startedAt: string,
        error: unknown,
        approvalId?: string
    ): Promise<never> {
        const completedAt = new Date().toISOString();
        const errorCode = getErrorCode(error, errorCodes.coreApprovalDenied);

        await this.#toolCallHistory.denied(callId, errorCode, completedAt);
        await this.#appendEvent(
            "toolCall.denied",
            toEventData({
                ...(approvalId === undefined ? {} : { approvalId }),
                callId,
                completedAt,
                errorCode,
                requestId: context.requestId,
                sessionId: context.sessionId,
                source: context.source,
                startedAt,
                status: "denied",
                toolName
            })
        );

        throw error;
    }

    async #expireToolCall(
        callId: string,
        toolName: string,
        context: ToolCallContext,
        startedAt: string,
        error: unknown,
        approvalId: string
    ): Promise<never> {
        const completedAt = new Date().toISOString();
        const errorCode = getErrorCode(error, errorCodes.coreApprovalExpired);

        await this.#toolCallHistory.expired(callId, errorCode, completedAt);
        await this.#appendEvent(
            "toolCall.expired",
            toEventData({
                approvalId,
                callId,
                completedAt,
                errorCode,
                requestId: context.requestId,
                sessionId: context.sessionId,
                source: context.source,
                startedAt,
                status: "expired",
                toolName
            })
        );

        throw error;
    }

    async #appendToolLogs(
        result: Pick<CommandResult, "stderr" | "stdout">,
        context: {
            callId: string;
            requestId?: string;
            sessionId?: string;
            source: ToolCallContext["source"];
            toolName: string;
        }
    ): Promise<void> {
        const at = new Date().toISOString();

        if (result.stdout.length > 0) {
            await this.#logStore.append("stdout", result.stdout, at);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes: readByteLength(result.stdout),
                    preview: readPreview(result.stdout),
                    stream: "stdout",
                    tail: readTail(result.stdout)
                })
            );
        }

        if (result.stderr.length > 0) {
            await this.#logStore.append("stderr", result.stderr, at);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes: readByteLength(result.stderr),
                    preview: readPreview(result.stderr),
                    stream: "stderr",
                    tail: readTail(result.stderr)
                })
            );
        }
    }

    async #applyStateUpdate(update: InstanceStateUpdate): Promise<InstanceSnapshot> {
        const previous = this.snapshot();
        const next = this.#stateMachine.apply(update);

        if (previous.daemonState !== next.daemonState || normalizeLifecycleStatus(previous.status) !== normalizeLifecycleStatus(next.status)) {
            await this.#appendEvent("instance.statusChanged", createStatusChangedEventData(previous, next));
        }

        if (previous.connectionState !== next.connectionState) {
            await this.#appendEvent("instance.connectionChanged", createConnectionChangedEventData(previous, next));
        }

        if (previous.ready !== next.ready) {
            await this.#appendEvent("instance.readyChanged", createReadyChangedEventData(previous, next));
        }

        return this.snapshot();
    }
}

function toInputSummary(input: JsonValue): string {
    const summary = (() => {
        if (Array.isArray(input)) {
            return input.map((value) => JSON.stringify(value) ?? "null").join(" ");
        }

        if (typeof input === "object" && input !== null) {
            return JSON.stringify(input) ?? "null";
        }

        return String(input);
    })();

    return summary.length <= 400 ? summary : `${summary.slice(0, 400)}...`;
}

function asCommandResult(error: unknown): CommandResult | undefined {
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        return undefined;
    }

    const candidate = error as Record<string, unknown>;

    if (
        typeof candidate.stdout === "string" &&
        typeof candidate.stderr === "string" &&
        (typeof candidate.exitCode === "number" || candidate.exitCode === null)
    ) {
        return {
            details: readCommandDiagnostic(candidate.details),
            exitCode: candidate.exitCode as number | null,
            signal: typeof candidate.signal === "string" ? candidate.signal : undefined,
            stderr: candidate.stderr,
            stdout: candidate.stdout,
            timedOut: candidate.timedOut === true
        };
    }

    const details = readCommandDiagnostic(candidate.details);

    if (details === undefined || (typeof details.exitCode !== "number" && details.exitCode !== null)) {
        return undefined;
    }

    return {
        details,
        exitCode: details.exitCode ?? null,
        signal: details.signal,
        stderr: "",
        stdout: "",
        timedOut: candidate.timedOut === true
    };
}

function asBashToolResult(value: JsonValue): {
    exitCode?: number | null;
    stderr: string;
    stderrBytes: number;
    stdout: string;
    stdoutBytes: number;
    termSignal?: number;
    termination?: "exited" | "signaled" | "timeout" | "outputLimit";
} | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const result = value as Record<string, JsonValue>;
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
        return undefined;
    }

    const termination = result.termination;
    return {
        ...(typeof result.exitCode === "number" || result.exitCode === null ? { exitCode: result.exitCode } : {}),
        stderr: result.stderr,
        stderrBytes: typeof result.stderrBytes === "number" ? result.stderrBytes : readByteLength(result.stderr),
        stdout: result.stdout,
        stdoutBytes: typeof result.stdoutBytes === "number" ? result.stdoutBytes : readByteLength(result.stdout),
        ...(typeof result.termSignal === "number" ? { termSignal: result.termSignal } : {}),
        ...(termination === "exited" || termination === "signaled" || termination === "timeout" || termination === "outputLimit" ? { termination } : {})
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

function isInteractiveSession(value: unknown): value is WorkerCommandInteractiveSession {
    return typeof value === "object" && value !== null && "readInput" in value && "writeOutput" in value;
}

function toEventData(
    record: Record<string, JsonValue | undefined>
): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
}

function toApprovalEventData(request: ApprovalRequest, decision?: ApprovalDecision): Record<string, JsonValue> {
    return toEventData({
        approvalId: request.approvalId,
        callId: request.callId,
        createdAt: request.createdAt,
        decidedAt: decision?.decidedAt,
        decidedBy: decision?.decidedBy,
        decision: decision?.decision,
        expiresAt: request.expiresAt,
        inputSummary: request.inputSummary,
        reason: decision?.reason ?? request.reason,
        requestId: request.requestId,
        remember: decision?.remember,
        riskLevel: request.riskLevel,
        sessionId: request.sessionId,
        source: request.source,
        status: request.status,
        toolName: request.toolName
    });
}

function createStatusChangedEventData(previous: InstanceSnapshot, next: InstanceSnapshot): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        pid: next.pid,
        previousDaemonState: previous.daemonState,
        previousStatus: previous.status,
        ready: next.ready,
        status: next.status
    });
}

function createConnectionChangedEventData(previous: InstanceSnapshot, next: InstanceSnapshot): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        pid: next.pid,
        previousConnectionState: previous.connectionState,
        ready: next.ready,
        status: next.status
    });
}

function createReadyChangedEventData(previous: InstanceSnapshot, next: InstanceSnapshot): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        pid: next.pid,
        previousReady: previous.ready,
        ready: next.ready,
        status: next.status
    });
}

function readByteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function readPreview(value: string): string {
    return value.slice(0, 160);
}

function readTail(value: string): string {
    return value.slice(-160);
}

function normalizeLifecycleStatus(status: InstanceSnapshot["status"]): "failed" | "running" | "stale" | "stopped" {
    return status === "ready" ? "running" : status;
}

function parseWorkerStatus(
    stdout: string,
    instanceName: string
): {
    daemonState: "running" | "stale" | "stopped";
    pid?: number;
    workspacePath?: string;
} {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout) as unknown;
    } catch (error) {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            cause: error,
            message: `Worker status returned an invalid payload for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000)
            }
        });
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            message: `Worker status returned an invalid payload for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000)
            }
        });
    }

    const candidate = parsed as Record<string, unknown>;
    const state = candidate.state;

    if (state !== "running" && state !== "stale" && state !== "stopped") {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            message: `Worker status returned an unknown state for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                state: String(state),
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000)
            }
        });
    }

    return {
        daemonState: state,
        pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
        workspacePath: typeof candidate.workspace === "string" ? candidate.workspace : undefined
    };
}

function withInstanceDetails(details: CommandDiagnostic | undefined, instance: string): CommandDiagnostic {
    return {
        ...(details ?? {}),
        instance
    };
}

function wrapWorkerCommandError(error: unknown, code: string, message: string, instance: string): unknown {
    if (!isKnownErrorCode(error) || getErrorCode(error, code) === code) {
        return error;
    }

    return createError({
        code,
        cause: error,
        message,
        retryable: false,
        details: toJsonDetails(withInstanceDetails(readCommandDiagnostic((error as { details?: unknown }).details), instance))
    });
}

function toJsonDetails(details: CommandDiagnostic): JsonValue {
    return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as JsonValue;
}

function readCommandDiagnostic(value: unknown): CommandDiagnostic | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;

    return {
        ...(typeof candidate.causeCode === "string" ? { causeCode: candidate.causeCode } : {}),
        ...(typeof candidate.causeMessage === "string" ? { causeMessage: candidate.causeMessage } : {}),
        ...(Array.isArray(candidate.command) ? { command: candidate.command.filter((entry): entry is string => typeof entry === "string") } : {}),
        ...(typeof candidate.commandDisplay === "string" ? { commandDisplay: candidate.commandDisplay } : {}),
        ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
        ...(typeof candidate.exitCode === "number" || candidate.exitCode === null ? { exitCode: candidate.exitCode as number | null } : {}),
        ...(typeof candidate.instance === "string" ? { instance: candidate.instance } : {}),
        ...(typeof candidate.operation === "string" ? { operation: candidate.operation } : {}),
        ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
        ...(typeof candidate.signal === "string" ? { signal: candidate.signal } : {}),
        ...(typeof candidate.stderrTail === "string" ? { stderrTail: candidate.stderrTail } : {}),
        ...(typeof candidate.stdoutTail === "string" ? { stdoutTail: candidate.stdoutTail } : {})
    };
}
