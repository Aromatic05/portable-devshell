import type { InstanceEventRecord, JsonValue, STREAM_GAP_CODE } from "@portable-devshell/shared";


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

export interface WorkerCommandInteractiveSession {
    readInput(): Promise<Buffer | undefined>;
    writeOutput(chunk: string): Promise<void> | void;
}
