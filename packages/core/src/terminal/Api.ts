import type {
    TerminalInspectResult,
    TerminalOutputFrame,
    TerminalSessionDescriptor,
} from "@portable-devshell/shared";

export interface WorkerTerminalDescriptor {
    cols: number;
    command?: string;
    createdAtMs: number;
    cwd?: string;
    generation: number;
    humanControl?: boolean;
    latestSeq: number;
    name?: string;
    persistent?: boolean;
    pty?: boolean;
    rows: number;
    state: "running" | "exited";
    terminalId: string;
    version: number;
    workspace?: string;
}

export interface WorkerTerminalOpenInput {
    cols: number;
    command?: string;
    cwd?: string;
    name?: string;
    persistent?: boolean;
    rows: number;
    shell?: string;
    workspace: string;
}

export interface WorkerTerminalInspectResult {
    cols: number;
    cursor: { col: number; row: number };
    lines: string[];
    rows: number;
    seq: number;
    session: WorkerTerminalDescriptor;
}

export interface WorkerTerminalIdentity {
    controller?: string;
    clientSeq: number;
    generation: number;
    terminalId: string;
    version: number;
}

export interface WorkerTerminalOutputFrame {
    dataBase64: string;
    seq: number;
}

export interface TerminalRestore {
    seq: number;
    data: string;
}

export interface WorkerTerminalAttachResult {
    snapshot?: TerminalRestore;
    exit?: { exitCode: number; signal: number };
    replay: WorkerTerminalOutputFrame[];
    session: WorkerTerminalDescriptor;
}

export type WorkerTerminalNotification =
    | {
          method: "terminal.error";
          params: { terminalId: string; generation: number; message: string };
      }
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
          method: "terminal.control";
          params: {
              cols?: number;
              cwd?: string;
              generation: number;
              humanControl: boolean;
              name?: string;
              rows?: number;
              terminalId: string;
              version?: number;
              workspace?: string;
          };
      }
    | {
          method: "terminal.exit";
          params: {
              exitCode: number;
              generation: number;
              latestSeq: number;
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
        restore?: boolean;
    }): Promise<WorkerTerminalAttachResult>;
    control?(input: {
        terminalId: string;
        generation: number;
        controller?: string;
        renew?: boolean;
    }): Promise<{
        controller?: string;
        session?: WorkerTerminalDescriptor;
        snapshot?: TerminalRestore;
        released?: boolean;
        renewed?: boolean;
    }>;
    inspect?(input: {
        generation: number;
        terminalId: string;
    }): Promise<WorkerTerminalInspectResult>;
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

export interface TerminalProcessMetadataUpdate {
    cols?: number;
    command?: string;
    cwd?: string;
    humanControl?: boolean;
    name?: string;
    persistent?: boolean;
    pty?: boolean;
    rows?: number;
    version?: number;
    workspace?: string;
}

export interface TerminalProcess {
    dispose?(): void;
    acquireControl?(): Promise<TerminalRestore>;
    releaseControl?(): Promise<void>;
    restoreSnapshot?(): Promise<TerminalRestore | undefined>;
    inspect?(): Promise<Omit<TerminalInspectResult, "session">>;
    kill(): void | Promise<void>;
    onData(listener: (data: string, sourceSeq?: number) => void): () => void;
    onError?(listener: (error: Error) => void): () => void;
    onControlLost?(listener: () => void): () => void;
    onExit(listener: (exit: TerminalProcessExit) => void): () => void;
    onMetadataChange?(
        listener: (update: TerminalProcessMetadataUpdate) => void,
    ): () => void;
    resize(cols: number, rows: number): void | Promise<void>;
    write(data: string): void | Promise<void>;
}

export interface TerminalBackendOpenInput {
    cols: number;
    command?: string;
    cwd?: string;
    name?: string;
    persistent?: boolean;
    rows: number;
    shell?: string;
    workspace: string;
}

export interface TerminalBackendSessionIdentity {
    cols?: number;
    command?: string;
    createdAt?: string;
    cwd?: string;
    humanControl?: boolean;
    name?: string;
    persistent?: boolean;
    pty?: boolean;
    recoverable?: boolean;
    rows?: number;
    generation: number;
    terminalId: string;
    version: number;
    workspace?: string;
}

export interface TerminalBackendSession {
    identity: TerminalBackendSessionIdentity;
    process: TerminalProcess;
}

export type TerminalBackendOpenResult =
    TerminalProcess | TerminalBackendSession;

export interface TerminalBackend {
    open(input: TerminalBackendOpenInput): Promise<TerminalBackendOpenResult>;
    recover?(known?: ReadonlySet<string>): Promise<TerminalBackendSession[]>;
    listMetadata?(): Promise<readonly TerminalBackendSessionIdentity[]>;
}

export interface TerminalSessionRuntimeOptions {
    idFactory?: () => string;
    maxReplayBytes?: number;
    maxTerminalHistory?: number;
    now?: () => Date;
    onControlReleased?(session: TerminalSessionDescriptor): void | Promise<void>;
}

export interface TerminalOpenRequest {
    backend: TerminalBackend;
    cols: number;
    command?: string;
    cwd?: string;
    instance: string;
    name?: string;
    persistent?: boolean;
    rows: number;
    shell?: string;
    workspace: string;
}

export interface TerminalAttachRequest {
    fromSeq: number;
    takeover?: boolean;
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
    releaseControl(): Promise<void>;
    restoreSnapshot(): Promise<TerminalRestore | undefined>;
    takeControl(): Promise<TerminalRestore | undefined>;
    resize(cols: number, rows: number): Promise<void>;
    write(data: string): Promise<void>;
}

export interface TerminalSessionApi {
    open(request: TerminalOpenRequest): Promise<TerminalSessionDescriptor>;
    recover(
        instance: string,
        backend: TerminalBackend,
    ): Promise<TerminalSessionDescriptor[]>;
    attach(request: TerminalAttachRequest): TerminalAttachment;
    get(terminalId: string): TerminalSessionDescriptor;
    inspect(
        terminalId: string,
        generation: number,
    ): Promise<TerminalInspectResult>;
    assertVersion(
        terminalId: string,
        generation: number,
        version: number,
    ): TerminalSessionDescriptor;
    list(instance?: string): TerminalSessionDescriptor[];
    kill(
        terminalId: string,
        generation: number,
        version: number,
    ): Promise<TerminalSessionDescriptor>;
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
