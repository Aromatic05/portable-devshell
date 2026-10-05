import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ControlConfig } from "@portable-devshell/shared";
import type { InstanceRegistry } from "./Registry.js";
import type { ArtifactPayloadDescriptor, Channel, ControlInstanceAlertsConfig, ControlMcpContextMode, Endpoint, InstanceEventRecord, InstanceSnapshot, JsonValue, MessageStream, ReverseEnrollmentState, ReverseTransport, ToolDefinition, STREAM_GAP_CODE } from "@portable-devshell/shared";
import type { Instance } from "./Instance.js";
import type { TransportConnection } from "./transport/endpoint/Connection.js";

export interface InstanceEventInput {
    at: string;
    data?: JsonValue;
    type: string;
}

export interface InstanceEventStreamGap {
    code: typeof STREAM_GAP_CODE;
    fromSeq: number;
    kind: "gap";
    lastSeq: number;
    nextSeq: number;
}

export interface InstanceEventStreamSlice {
    events: InstanceEventRecord[];
    kind: "events";
    lastSeq: number;
}

export interface InstanceEventSource {
    cursor(): number;
    subscribe(
        fromSeq?: number,
    ): InstanceEventStreamGap | InstanceEventStreamSlice;
}

export interface InstanceEventPort {
    cursor(): number;
    append(event: InstanceEventInput): Promise<InstanceEventRecord>;
    readFrom(
        fromSeq?: number,
    ): InstanceEventStreamGap | InstanceEventStreamSlice;
}

export interface WorkerTerminalDescriptor {
    cols: number;
    createdAtMs: number;
    generation: number;
    latestSeq: number;
    rows: number;
    state: "running" | "exited";
    terminalId: string;
    version: number;
}

export interface WorkerTerminalOpenInput {
    cols: number;
    command?: string;
    cwd?: string;
    rows: number;
    workspace: string;
}

export interface WorkerTerminalIdentity {
    clientSeq: number;
    generation: number;
    terminalId: string;
    version: number;
}

export interface WorkerTerminalOutputFrame {
    dataBase64: string;
    seq: number;
}

export interface WorkerTerminalAttachResult {
    exit?: { exitCode: number; signal: number };
    replay: WorkerTerminalOutputFrame[];
    session: WorkerTerminalDescriptor;
}

export type WorkerTerminalNotification =
    | {
          method: "terminal.output";
          params: {
              dataBase64: string;
              generation: number;
              seq: number;
              terminalId: string;
          };
      }
    | {
          method: "terminal.exit";
          params: {
              exitCode: number;
              generation: number;
              signal: number;
              terminalId: string;
              version: number;
          };
      };

export type WorkerArtifactPayloadOpenInput =
    | { expiresAtMs: number; handle: string; path?: never }
    | { expiresAtMs: number; handle?: never; path: string; workspace: string };

export interface WorkerArtifactPayloadOpenResult {
    descriptor: ArtifactPayloadDescriptor;
    expiresAtMs: number;
    payloadId: string;
}

export interface WorkerArtifactReceiveBeginInput {
    descriptor: ArtifactPayloadDescriptor;
    overwrite: boolean;
    targetPath: string;
    workspace: string;
}

export interface WorkerArtifactReceiveBeginResult {
    nextOffsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveFinishResult {
    blake3: string;
    bytes: number;
    receiveId: string;
    targetPath: string;
}

export interface WorkerArtifactDirectReceiveOpenInput {
    expiresAtMs: number;
    receiveId: string;
}

export interface WorkerArtifactDirectReceiveOpenResult {
    expiresAtMs: number;
    nextOffsetBytes: number;
    receiverId: string;
    urls: string[];
}

export interface WorkerArtifactDirectPushInput {
    maxBytes: number;
    offsetBytes: number;
    payloadId: string;
    urls: string[];
}

export interface WorkerArtifactDirectPushResult {
    nextOffsetBytes: number;
    pushedBytes: number;
}

export interface WorkerArtifactPayloadReadInput {
    maxBytes: number;
    offsetBytes: number;
    payloadId: string;
}

export interface WorkerArtifactPayloadReadResult {
    bytes: Uint8Array;
    eof: boolean;
    nextOffsetBytes?: number;
    offsetBytes: number;
    payloadId: string;
    returnedBytes: number;
    totalBytes: number;
}

export interface WorkerArtifactReceiveWriteInput {
    bytes: Uint8Array;
    offsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveWriteResult {
    nextOffsetBytes: number;
    receivedBytes: number;
    receiveId: string;
}

export interface WorkerProtocolRange {
    min: string;
    max: string;
}

export interface WorkerHandshakeParams {
    protocolRange: WorkerProtocolRange;
    clientName: string;
    clientVersion: string;
}

export interface WorkerPingResult {
    pong: boolean;
}

export interface WorkerStopResult {
    stopping: boolean;
}

export interface WorkerCommandSessionOutputInput {
    data: string;
    sessionId: string;
    stream: "stderr" | "stdout";
}

export interface WorkerCommandSessionCompleteInput {
    error?: string;
    exitCode: number;
    sessionId: string;
}

export interface WorkerShellRuntime {
    executable: string;
    kind: "bash" | "powershell" | string;
    version: string;
}

export interface WorkerHandshakeResult {
    homeDirectory: string;
    instance: string;
    workerVersion: string;
    workerSha256?: string;
    protocolVersion: string;
    platform: {
        os: string;
        arch: string;
        distribution?: { id: string; name: string; version?: string };
        packageManager?: string;
        shell?: WorkerShellRuntime;
    };
    capabilities: {
        tools: boolean;
        streaming: boolean;
        cancel: boolean;
    };
}

export interface WorkerToolDefinition {
    requiredCapabilities: readonly ("read" | "write" | "execute")[];
    name: string;
    description: string;
    group: string;
    inputSchema: JsonValue;
    outputSchema: JsonValue;
}

export interface WorkerToolsListResult {
    tools: WorkerToolDefinition[];
}

export interface WorkerWorkspacePrepareResult {
    projectMemoryAgentFile: string;
    projectMemoryDirectory: string;
    projectMemoryPresent?: boolean;
    temporaryDirectory: string;
    workspace: string;
}

export interface WorkerExtensionResourcePrepareInput {
    collection: string;
    extensionId: string;
}

export interface WorkerExtensionResourcePrepareResult {
    directory: string;
}

export interface WorkerAlertAdvice {
    code: string;
    text: string;
}

export interface WorkerAlertsReadResult {
    advice: WorkerAlertAdvice[];
}

export interface WorkerCommandSessionOpen {
    argv: readonly string[];
    ctxId: string;
    cwd: string;
    parentCallId: string;
    sessionId: string;
    taskId?: string;
    workspace: string;
}

export interface WorkerCommandSessionClose {
    sessionId: string;
}

export type WorkerCommandSessionStream = "stderr" | "stdout";

export interface WorkerCommandSessionOutput {
    data: string;
    sessionId: string;
    stream: WorkerCommandSessionStream;
}

export interface WorkerCommandSessionCompletion {
    error?: string;
    exitCode: number;
    sessionId: string;
}

export interface WorkerTcpConnectInput {
    host: string;
    port: number;
}

export interface WorkerExecProcessInput {
    executable: string;
    args?: readonly string[];
    cwd?: string;
}

export interface InstanceLease {
    readonly instance: Instance;
    release(): void;
}

export interface InstanceReferenceLease {
    snapshot: ReturnType<WorkerInstance["snapshot"]>;
    worker: WorkerInstance;
}

export interface InstanceFields {
    enabled: boolean;
    mcpContextMode?: ControlMcpContextMode;
    mcpEnabled: boolean;
    mcpPath: string;
    modelExtensions: readonly string[];
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: TransportConnection;
    worker: WorkerInstance;
}

export interface WorkerInstance {
    snapshot(): InstanceSnapshot;
    readonly endpoint: Endpoint;
    readWorkerTools(): Promise<readonly ToolDefinition[]>;
    readonly managementMode: "controllerManaged" | "selfManaged";
    retireProviderResources(): Promise<void>;
    retireRuntime(): Promise<void>;
    setReverseEnrollmentState(
        enrollmentState: ReverseEnrollmentState,
    ): Promise<InstanceSnapshot>;
    acceptReverseChannel(
        channel: Channel,
        input: {
            connectedAt?: string;
            generation: number;
            transport: ReverseTransport;
        },
    ): Promise<InstanceSnapshot>;
    connectTcp(
        input: WorkerTcpConnectInput,
        signal?: AbortSignal,
    ): Promise<MessageStream>;
    execProcess(
        input: WorkerExecProcessInput,
        signal?: AbortSignal,
    ): Promise<MessageStream>;
    openTerminal(
        input: WorkerTerminalOpenInput,
    ): Promise<WorkerTerminalDescriptor>;
    prepareWorkspace(
        workspace: string,
    ): Promise<WorkerWorkspacePrepareResult>;
    readAlerts(
        workspace: string,
    ): Promise<WorkerAlertsReadResult>;
    touchAlerts(
        workspace: string,
    ): Promise<WorkerAlertsReadResult>;
    releaseAlerts(workspace: string): Promise<void>;
    touchTemporaryDirectory(path: string): Promise<void>;
    attachTerminal(input: {
        fromSeq: number;
        generation: number;
        terminalId: string;
    }): Promise<WorkerTerminalAttachResult>;
    writeTerminal(
        input: WorkerTerminalIdentity & { data: string },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }>;
    resizeTerminal(
        input: WorkerTerminalIdentity & { cols: number; rows: number },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }>;
    killTerminal(
        input: WorkerTerminalIdentity,
    ): Promise<WorkerTerminalDescriptor>;
    listTerminals(): Promise<WorkerTerminalDescriptor[]>;
    onTerminalNotification(
        listener: (notification: WorkerTerminalNotification) => void,
    ): () => void;
    onTransportConnected(listener: () => void): () => void;
    onTransportDisconnected(listener: (error: Error) => void): () => void;
    onCommandSessionOpen(
        listener: (request: WorkerCommandSessionOpen) => void,
    ): () => void;
    onCommandSessionClose(
        listener: (request: WorkerCommandSessionClose) => void,
    ): () => void;
    writeCommandSessionOutput(
        output: WorkerCommandSessionOutput,
    ): Promise<void>;
    completeCommandSession(
        completion: WorkerCommandSessionCompletion,
    ): Promise<void>;
    appendControlEvent(
        type: InstanceEventInput["type"],
        data?: JsonValue,
    ): Promise<InstanceEventRecord>;
    openArtifactPayload(
        input: WorkerArtifactPayloadOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadOpenResult>;
    readArtifactPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult>;
    closeArtifactPayload(payloadId: string): Promise<void>;
    prepareExtensionResource(
        input: WorkerExtensionResourcePrepareInput,
    ): Promise<WorkerExtensionResourcePrepareResult>;
    beginArtifactReceive(
        input: WorkerArtifactReceiveBeginInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveBeginResult>;
    writeArtifactReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult>;
    finishArtifactReceive(
        receiveId: string,
    ): Promise<WorkerArtifactReceiveFinishResult>;
    abortArtifactReceive(receiveId: string): Promise<void>;
    openArtifactDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactDirectReceiveOpenResult>;
    closeArtifactDirectReceive(receiverId: string): Promise<void>;
    pushArtifactPayloadDirect(
        input: WorkerArtifactDirectPushInput,
    ): Promise<WorkerArtifactDirectPushResult>;
    start(): Promise<InstanceSnapshot>;
    startInteractive(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<InstanceSnapshot>;
    stop(): Promise<InstanceSnapshot>;
    refreshStatus(): Promise<InstanceSnapshot>;
    reconfigure(input: {
        alerts?: ControlInstanceAlertsConfig;
        effectiveSecurityMode: "disabled" | "workspace";
        env?: NodeJS.ProcessEnv;
    }): Promise<void>;
    subscribe(fromSeq?: number): InstanceEventStreamGap | InstanceEventStreamSlice;
    close(): Promise<void>;
    readonly handshake: WorkerHandshakeResult | undefined;
    reconnectTransport(): Promise<InstanceSnapshot>;
}

export interface WorkerCommandInteractiveSession {
    readInput(): Promise<Buffer | undefined>;
    writeOutput(chunk: string): Promise<void> | void;
}

export interface ReverseConnectionIdentity {
    credentialToken: string;
    descriptor: ReverseInstance;
    generation: number;
}

export interface ReverseInstance {
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: TransportConnection;
}

export interface ReverseInstanceHandle extends ReverseInstance {
    acquireLease(): {
        readonly instance: ReverseInstance;
        release(): void;
    };
}

export interface ReverseInstanceLookup {
    get(instanceName: string): ReverseInstanceHandle | undefined;
}

export interface ReverseEnrollmentCredential {
    deviceToken: string;
    instance: string;
}

export interface StoredReverseDeviceCode {
    deviceCode: string;
    expiresAt: string;
    instance: import("@portable-devshell/shared").InstanceName;
}

interface ConnectionLifecyclePort {
    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void;
    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void;
}

export interface ReverseHttpHost {
    registerRawRoute(
        method: "delete" | "get" | "head" | "options" | "post",
        path: string,
        handler: (
            request: IncomingMessage,
            response: ServerResponse,
        ) => void | Promise<void>,
    ): () => void;
    registerUpgradeHandler(
        path: string,
        handler: (
            request: IncomingMessage,
            socket: Duplex,
            head: Buffer,
        ) => void | Promise<void>,
    ): () => void;
}

interface ConnectionMcpPort {
    readonly instanceEditor: ConnectionLifecyclePort;
    readonly host?: {
        readonly server: ReverseHttpHost;
    };
}

interface ConnectionStatePort {
    readonly homeDirectory?: string;
    readonly instances: InstanceRegistry;
    requireConfig(): ControlConfig;
}

export interface ConnectionModuleOptions {
    mcp: ConnectionMcpPort;
    state: ConnectionStatePort;
}
