// Terminal session model. A terminal is an instance-scoped PTY whose output is
// a versioned, sequence-ordered stream. The attach protocol is bidirectional:
// the server seeds a session, emits ordered output frames, and acknowledges
// input/resize; the client acknowledges output through a bounded window.

export type TerminalSessionState =
    | "running"
    | "exited"
    | "killed"
    | "lost"
    | "failed";

export interface TerminalSessionDescriptor {
    cols: number;
    createdAt: string;
    generation: number;
    instance: string;
    latestSeq: number;
    rows: number;
    state: TerminalSessionState;
    terminalId: string;
    version: number;
}

export interface TerminalOpenInput {
    cols: number;
    command?: string;
    cwd?: string;
    rows: number;
    workspace: string;
}

export interface TerminalOpenResult extends TerminalSessionDescriptor {}

export interface TerminalAttachInput {
    fromSeq: number;
    generation: number;
    terminalId: string;
}

export interface TerminalOutputFrame {
    data: string;
    seq: number;
}

export interface TerminalAttachResult {
    exit?: { exitCode: number; signal: number };
    replay: TerminalOutputFrame[];
    session: TerminalSessionDescriptor;
}

export interface TerminalVersionedIdentity {
    generation: number;
    terminalId: string;
    version: number;
}

export interface TerminalStreamCommandIdentity extends TerminalVersionedIdentity {
    clientSeq: number;
}

export interface TerminalExitEvent {
    exitCode: number;
    signal?: number;
}

export type TerminalStreamMessage =
    | { kind: "seed"; session: TerminalSessionDescriptor }
    | { frame: TerminalOutputFrame; kind: "output" }
    | {
          clientSeq: number;
          identity: TerminalVersionedIdentity;
          kind: "inputAccepted" | "resized";
      }
    | { event: TerminalExitEvent; kind: "exit" }
    | { kind: "closed"; error?: Error; session?: TerminalSessionDescriptor };
