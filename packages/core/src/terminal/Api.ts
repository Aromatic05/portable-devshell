import type {
    TerminalOutputFrame,
    TerminalSessionDescriptor,
} from "@portable-devshell/shared";

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

export interface WorkerTerminalPort {
    open(input: WorkerTerminalOpenInput): Promise<WorkerTerminalDescriptor>;
    attach(input: {
        fromSeq: number;
        generation: number;
        terminalId: string;
    }): Promise<WorkerTerminalAttachResult>;
    write(
        input: WorkerTerminalIdentity & { data: string },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }>;
    resize(
        input: WorkerTerminalIdentity & { cols: number; rows: number },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }>;
    kill(input: WorkerTerminalIdentity): Promise<WorkerTerminalDescriptor>;
    list(): Promise<WorkerTerminalDescriptor[]>;
    onNotification(
        listener: (notification: WorkerTerminalNotification) => void,
    ): () => void;
    onConnected(listener: () => void): () => void;
    onDisconnected(listener: (error: Error) => void): () => void;
}

export interface TerminalProcessExit {
    exitCode: number;
    signal: number;
}

export interface TerminalProcess {
    dispose?(): void;
    kill(): void | Promise<void>;
    onData(listener: (data: string, sourceSeq?: number) => void): () => void;
    onError?(listener: (error: Error) => void): () => void;
    onExit(listener: (exit: TerminalProcessExit) => void): () => void;
    resize(cols: number, rows: number): void | Promise<void>;
    write(data: string): void | Promise<void>;
}

export interface TerminalBackendOpenInput {
    cols: number;
    command?: string;
    cwd?: string;
    rows: number;
    workspace: string;
}

export interface TerminalBackendSessionIdentity {
    cols?: number;
    createdAt?: string;
    recoverable?: boolean;
    rows?: number;
    generation: number;
    terminalId: string;
    version: number;
}

export interface TerminalBackendSession {
    identity: TerminalBackendSessionIdentity;
    process: TerminalProcess;
}

export type TerminalBackendOpenResult =
    | TerminalProcess
    | TerminalBackendSession;

export interface TerminalBackend {
    open(input: TerminalBackendOpenInput): Promise<TerminalBackendOpenResult>;
    recover?(): Promise<TerminalBackendSession[]>;
}

export interface TerminalSessionRuntimeOptions {
    idFactory?: () => string;
    maxReplayBytes?: number;
    maxTerminalHistory?: number;
    now?: () => Date;
}

export interface TerminalOpenRequest {
    backend: TerminalBackend;
    cols: number;
    command?: string;
    cwd?: string;
    instance: string;
    rows: number;
    workspace: string;
}

export interface TerminalAttachRequest {
    fromSeq: number;
    generation: number;
    onExit?(exit: TerminalProcessExit): void;
    onOutput(frame: TerminalOutputFrame): void;
    terminalId: string;
}

export interface TerminalAttachment {
    readonly exit?: TerminalProcessExit;
    readonly replay: TerminalOutputFrame[];
    readonly session: TerminalSessionDescriptor;
    detach(): void;
    resize(cols: number, rows: number): Promise<void>;
    write(data: string): Promise<void>;
}

export interface TerminalSessionApi {
    open(request: TerminalOpenRequest): Promise<TerminalSessionDescriptor>;
    recover(instance: string, backend: TerminalBackend): Promise<TerminalSessionDescriptor[]>;
    attach(request: TerminalAttachRequest): TerminalAttachment;
    get(terminalId: string): TerminalSessionDescriptor;
    assertVersion(terminalId: string, generation: number, version: number): TerminalSessionDescriptor;
    list(instance?: string): TerminalSessionDescriptor[];
    kill(terminalId: string, generation: number, version: number): Promise<TerminalSessionDescriptor>;
    closeInstance(instance: string): Promise<void>;
}

export interface TerminalSessionRuntime {
    readonly api: TerminalSessionApi;
    close(): void;
}

export interface TerminalRuntime {
    readonly api: TerminalBackend;
    readonly sessions: TerminalSessionRuntime;
}
