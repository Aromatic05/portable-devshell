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

export type TerminalBackendOpenResult = TerminalProcess | TerminalBackendSession;

export interface TerminalBackend {
    open(input: TerminalBackendOpenInput): Promise<TerminalBackendOpenResult>;
    recover?(): Promise<TerminalBackendSession[]>;
}
