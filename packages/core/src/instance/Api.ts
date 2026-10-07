import type {
    InstanceEventRecord,
    InstanceEventStreamGap,
    InstanceEventStreamSlice,
    JsonValue,
} from "@portable-devshell/shared";


export interface InstanceEventInput {
    at: string;
    data?: JsonValue;
    type: string;
}

export interface InstanceEventPort {
    cursor(): number;
    append(event: InstanceEventInput): Promise<InstanceEventRecord>;
    readFrom(
        fromSeq?: number,
    ): InstanceEventStreamGap | InstanceEventStreamSlice;
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

export interface WorkerCommandInteractiveSession {
    readInput(): Promise<Buffer | undefined>;
    writeOutput(chunk: string): Promise<void> | void;
}

export type { WorkerExecution, WorkerInstance } from "./runtime/Api.js";
export type { InstanceLease } from "./model/Lifecycle.js";
export type { InstanceState } from "./model/State.js";
export type { InstanceToolDefinitionRegistration } from "./model/Tools.js";
