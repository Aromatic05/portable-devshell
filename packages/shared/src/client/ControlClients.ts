import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
} from "../dto/artifact/DtoArtifact.js";
import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
} from "../config/ConfigModel.js";
import type {
    ContextMessageQueueInput,
    ContextMessageRecord,
} from "../dto/context/DtoContextMessage.js";
import type { McpContextRecord } from "../dto/context/DtoContextRecord.js";
import {
    CONTROL_PROTOCOL_VERSION,
    type ControlClientKind,
    type ControlProtocolHelloResponse,
} from "../dto/DtoControlProtocol.js";
import type {
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
} from "../dto/instance/DtoInstanceCreate.js";
import type { InstanceLogEntry } from "../dto/instance/DtoInstanceLog.js";
import type {
    InstanceListEntry,
    InstanceRuntimeEnvelope,
} from "../dto/instance/DtoInstanceRuntime.js";
import type { InstanceSnapshot } from "../dto/instance/DtoInstanceSnapshot.js";
import type { TodoRpcEnvelope } from "../dto/instance/DtoTodo.js";
import type {
    OAuthApprovalDecision,
    OAuthApprovalRequest,
} from "../dto/oauth/DtoOAuthApproval.js";
import type { OperationalOverview } from "../dto/overview/DtoOperationalOverview.js";
import type { ReverseDeviceCodeResult } from "../dto/reverse/DtoReverseConnection.js";
import type {
    TerminalAttachInput,
    TerminalOpenInput,
    TerminalOpenResult,
    TerminalSessionDescriptor,
    TerminalVersionedIdentity,
} from "../dto/terminal/DtoTerminal.js";
import type {
    ApprovalDecision,
    ApprovalRequest,
} from "../dto/tool/DtoToolApproval.js";
import type {
    ToolCallQuery,
    ToolCallRecord,
} from "../dto/tool/DtoToolCallRecord.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { asInstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import {
    controlClientModule,
    instanceClientModule,
    type ClientConnection,
    type OpenedClientStream,
} from "../transport/ClientConnection.js";
import { InstanceEventStream } from "./InstanceEventStream.js";

export interface ControlServiceStatus {
    instanceCount: number;
    ok: boolean;
    pid?: number;
}

export interface McpRuntimeStatus extends Record<string, JsonValue | undefined> {
    authMode?: "none" | "oauth2" | "token";
    oauthReady?: boolean;
    publicBaseUrl?: string;
    reason?: string;
    running: boolean;
}

export interface RuntimeStartOptions {
    onOutput?(chunk: string): void;
    onRequestId?(requestId: string): void;
    signal?: AbortSignal;
}

export interface ControlClients {
    artifact: {
        cancelTransfer(transferId: string): Promise<ArtifactTransferResult>;
        createShare(defaultInstance: string, input: ArtifactShareInput): Promise<ArtifactShareResult>;
        getTransfer(transferId: string): Promise<ArtifactTransferRecord>;
        listShares(): Promise<ArtifactShareResult[]>;
        listTransfers(): Promise<ArtifactTransferRecord[]>;
        revokeShare(shareId: string): Promise<ArtifactShareRevokeResult>;
        startTransfer(
            defaultInstance: string,
            input: ArtifactTransferStartInput,
        ): Promise<ArtifactTransferResult>;
        viewImage(
            defaultInstance: string,
            input: ArtifactViewImageInput,
        ): Promise<ArtifactViewImageResult>;
    };
    config: {
        get(): Promise<Record<string, JsonValue>>;
        update(request: ConfigBatchUpdateRequest): Promise<JsonValue>;
        updateInstance(request: ConfigUpdateInstanceRequest): Promise<Record<string, JsonValue>>;
        updateMcpEndpoint(request: ConfigUpdateMcpRequest): Promise<Record<string, JsonValue>>;
        updateWeb(request: ConfigUpdateWebRequest): Promise<Record<string, JsonValue>>;
        validate(draft: ConfigDraft): Promise<Record<string, JsonValue>>;
    };
    context: {
        disable(ctxId: string): Promise<McpContextRecord>;
        list(): Promise<McpContextRecord[]>;
        renew(ctxId: string): Promise<McpContextRecord>;
    };
    contextMessage: {
        list(instance: string, ctxId?: string): Promise<ContextMessageRecord[]>;
        queue(instance: string, input: ContextMessageQueueInput): Promise<ContextMessageRecord>;
    };
    instance: {
        create(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
        createSchema(): Promise<InstanceCreateSchema>;
        delete(instanceName: string): Promise<Record<string, JsonValue>>;
        disable(instanceName: string): Promise<Record<string, JsonValue>>;
        enable(instanceName: string): Promise<Record<string, JsonValue>>;
        list(): Promise<InstanceListEntry[]>;
        validateCreate(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
    };
    mcp: {
        decideApproval(
            approvalId: string,
            decision: OAuthApprovalDecision,
        ): Promise<OAuthApprovalRequest>;
        listApprovals(): Promise<OAuthApprovalRequest[]>;
        status(): Promise<McpRuntimeStatus>;
    };
    overview: { get(): Promise<OperationalOverview> };
    reverse: {
        createCode(instance: string): Promise<ReverseDeviceCodeResult>;
        revokeToken(instance: string): Promise<{ instance: string; revoked: true }>;
        rotateToken(instance: string): Promise<{ deviceToken: string; instance: string }>;
    };
    runtime: {
        openStart(instance: string): Promise<OpenedClientStream>;
        readLogs(
            instance: string,
            query?: { fromSeq?: number; limit?: number },
        ): Promise<InstanceLogEntry[]>;
        refresh(instance: string): Promise<InstanceRuntimeEnvelope>;
        snapshot(instance: string): Promise<InstanceRuntimeEnvelope>;
        start(instance: string, options?: RuntimeStartOptions): Promise<InstanceSnapshot>;
        stop(instance: string): Promise<InstanceSnapshot>;
        subscribe(instance: string, fromSeq: number): Promise<InstanceEventStream>;
    };
    service: {
        hello(): Promise<ControlProtocolHelloResponse>;
        ping(): Promise<{ pong: boolean }>;
        restart(): Promise<Record<string, JsonValue>>;
        status(): Promise<ControlServiceStatus>;
    };
    terminal: {
        attach(instance: string, input: TerminalAttachInput): Promise<OpenedClientStream>;
        get(
            instance: string,
            identity: Pick<TerminalVersionedIdentity, "generation" | "terminalId">,
        ): Promise<TerminalSessionDescriptor>;
        kill(
            instance: string,
            identity: TerminalVersionedIdentity,
        ): Promise<TerminalSessionDescriptor>;
        list(instance: string): Promise<TerminalSessionDescriptor[]>;
        open(instance: string, input: TerminalOpenInput): Promise<TerminalOpenResult>;
    };
    todo: {
        delete(instance: string, taskId: string): Promise<Record<string, JsonValue>>;
        get(instance: string, title?: string): Promise<TodoRpcEnvelope>;
        subscribe(instance: string, fromSeq: number): Promise<InstanceEventStream>;
    };
    tool: {
        call(instance: string, toolName: string, input: JsonValue, workspace: string): Promise<JsonValue>;
        decideApproval(
            instance: string,
            approvalId: string,
            decision: ApprovalDecision["decision"],
            options?: { policyPatch?: JsonValue; reason?: string; remember?: boolean },
        ): Promise<ApprovalRequest>;
        getApproval(instance: string, approvalId: string): Promise<ApprovalRequest>;
        listApprovals(instance: string): Promise<ApprovalRequest[]>;
        listCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    };
}

export function createControlClients(
    connection: ClientConnection,
    options: { clientKind: ControlClientKind },
): ControlClients {
    const artifact = controlClientModule(connection, "artifact");
    const config = controlClientModule(connection, "config");
    const context = controlClientModule(connection, "context");
    const instance = controlClientModule(connection, "instance");
    const mcp = controlClientModule(connection, "mcp");
    const overview = controlClientModule(connection, "overview");
    const reverse = controlClientModule(connection, "reverse");
    const service = controlClientModule(connection, "service");
    const contextMessage = instanceClientModule(connection, "contextMessage");
    const runtime = instanceClientModule(connection, "runtime");
    const terminal = instanceClientModule(connection, "terminal");
    const todo = instanceClientModule(connection, "todo");
    const tool = instanceClientModule(connection, "tool");
    const openRuntimeStart = (name: string): Promise<OpenedClientStream> =>
        runtime.openStream(name, "start");

    return {
        artifact: {
            cancelTransfer: (transferId) =>
                artifact.request("cancelTransfer", { transferId }),
            createShare: (defaultInstance, input) =>
                artifact.request("createShare", { ...input, defaultInstance }),
            getTransfer: (transferId) => artifact.request("getTransfer", { transferId }),
            listShares: () => artifact.request("listShares"),
            listTransfers: () => artifact.request("listTransfers"),
            revokeShare: (shareId) => artifact.request("revokeShare", { shareId }),
            startTransfer: (defaultInstance, input) =>
                artifact.request("startTransfer", { ...input, defaultInstance }),
            viewImage: (defaultInstance, input) =>
                artifact.request("viewImage", { ...input, defaultInstance }),
        },
        config: {
            get: () => config.request("get"),
            update: (request) => config.request("update", request),
            updateInstance: (request) => config.request("updateInstance", request),
            updateMcpEndpoint: (request) =>
                config.request("updateMcpEndpoint", request),
            updateWeb: (request) => config.request("updateWeb", request),
            validate: (draft) => config.request("validate", draft),
        },
        context: {
            disable: (ctxId) => context.request("disable", { ctxId }),
            list: () => context.request("list"),
            renew: (ctxId) => context.request("renew", { ctxId }),
        },
        contextMessage: {
            list: (name, ctxId) =>
                contextMessage.request(
                    name,
                    "list",
                    ctxId === undefined ? {} : { ctxId },
                ),
            queue: (name, input) => contextMessage.request(name, "queue", input),
        },
        instance: {
            create: (draft) => instance.request("create", draft),
            createSchema: () => instance.request("createSchema"),
            delete: (instanceName) => instance.request("delete", { instanceName }),
            disable: (instanceName) => instance.request("disable", { instanceName }),
            enable: (instanceName) => instance.request("enable", { instanceName }),
            list: () => instance.request("list"),
            validateCreate: (draft) => instance.request("validateCreate", draft),
        },
        mcp: {
            decideApproval: (approvalId, decision) =>
                mcp.request("decideApproval", { approvalId, decision }),
            listApprovals: () => mcp.request("listApprovals"),
            status: () => mcp.request("status"),
        },
        overview: { get: () => overview.request("get") },
        reverse: {
            createCode: (name) => reverse.request("createCode", { instance: name }),
            revokeToken: (name) => reverse.request("revokeToken", { instance: name }),
            rotateToken: (name) => reverse.request("rotateToken", { instance: name }),
        },
        runtime: {
            openStart: openRuntimeStart,
            readLogs: (name, query) => runtime.request(name, "readLogs", query),
            refresh: (name) => runtime.request(name, "refresh"),
            snapshot: (name) => runtime.request(name, "snapshot"),
            start: async (name, startOptions = {}) =>
                await startRuntime(
                    connection,
                    openRuntimeStart,
                    name,
                    startOptions,
                ),
            stop: (name) => runtime.request(name, "stop"),
            subscribe: async (name, fromSeq) =>
                new InstanceEventStream(
                    asInstanceName(name),
                    await runtime.openStream(name, "subscribe", { fromSeq }),
                ),
        },
        service: {
            hello: () =>
                service.request("hello", {
                    clientKind: options.clientKind,
                    maxProtocolVersion: CONTROL_PROTOCOL_VERSION,
                    minProtocolVersion: CONTROL_PROTOCOL_VERSION,
                }),
            ping: () => service.request("ping"),
            restart: () => service.request("restart"),
            status: () => service.request("status"),
        },
        terminal: {
            attach: (name, input) => terminal.openStream(name, "attach", input),
            get: (name, identity) => terminal.request(name, "get", identity),
            kill: (name, identity) => terminal.request(name, "kill", identity),
            list: (name) => terminal.request(name, "list"),
            open: (name, input) => terminal.request(name, "open", input),
        },
        todo: {
            delete: (name, taskId) => todo.request(name, "delete", { taskId }),
            get: (name, title) =>
                todo.request(name, "get", title === undefined ? {} : { title }),
            subscribe: async (name, fromSeq) =>
                new InstanceEventStream(
                    asInstanceName(name),
                    await todo.openStream(name, "subscribe", { fromSeq }),
                ),
        },
        tool: {
            call: (name, toolName, input, workspace) =>
                tool.request(name, "call", { input, toolName, workspace }),
            decideApproval: (name, approvalId, decision, decisionOptions = {}) =>
                tool.request(name, "decideApproval", {
                    approvalId,
                    decision,
                    ...decisionOptions,
                }),
            getApproval: (name, approvalId) =>
                tool.request(name, "getApproval", { approvalId }),
            listApprovals: (name) => tool.request(name, "listApprovals"),
            listCalls: (name, query) => tool.request(name, "listCalls", query),
        },
    };
}

async function startRuntime(
    connection: ClientConnection,
    openStart: (instance: string) => Promise<OpenedClientStream>,
    instance: string,
    options: RuntimeStartOptions,
): Promise<InstanceSnapshot> {
    let stream: import("../transport/ClientConnection.js").ClientStream | undefined;
    try {
        const opened = await openStart(instance);
        stream = opened.stream;
        options.onRequestId?.(stream.id);
        const aborted = () => stream?.close();
        options.signal?.addEventListener("abort", aborted, { once: true });
        try {
            if (options.signal?.aborted === true) {
                stream.close();
                throw abortError(options.signal);
            }
            while (true) {
                const event = await stream.nextEvent();
                if (event.name === "runtime.output") {
                    const payload = record(event.payload);
                    if (typeof payload?.chunk === "string") {
                        options.onOutput?.(payload.chunk);
                    }
                    continue;
                }
                if (event.name === "stream.completed") {
                    return readInstanceSnapshot(event.payload);
                }
                if (event.name === "stream.cancelled") {
                    connection.throwRemoteError(event.error);
                    throw new Error("Runtime start was cancelled.");
                }
            }
        } finally {
            options.signal?.removeEventListener("abort", aborted);
        }
    } catch (error) {
        throw connection.mapError(error);
    } finally {
        stream?.close();
    }
}

export function readInstanceSnapshot(value: JsonValue | undefined): InstanceSnapshot {
    const snapshot = record(value);
    if (
        snapshot === undefined ||
        typeof snapshot.name !== "string" ||
        typeof snapshot.lastSeq !== "number" ||
        typeof snapshot.ready !== "boolean" ||
        !isOneOf(snapshot.connectionState, [
            "connected",
            "connecting",
            "disconnected",
            "reconnecting",
            "failed",
        ]) ||
        !isOneOf(snapshot.daemonState, [
            "running",
            "starting",
            "stopped",
            "stale",
            "stopping",
            "failed",
        ]) ||
        !isOneOf(snapshot.status, [
            "ready",
            "running",
            "stale",
            "stopped",
            "failed",
        ])
    ) {
        throw new Error("Invalid runtime snapshot.");
    }
    return snapshot as unknown as InstanceSnapshot;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function isOneOf<T extends string>(
    value: JsonValue | undefined,
    values: readonly T[],
): value is T {
    return typeof value === "string" && values.includes(value as T);
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Runtime start was aborted.");
}
