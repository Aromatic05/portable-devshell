import type {
    TerminalOutputFrame,
    TerminalSessionDescriptor,
} from "@portable-devshell/shared";

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
}
