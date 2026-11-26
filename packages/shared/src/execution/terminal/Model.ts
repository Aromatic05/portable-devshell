// Terminal session model. A terminal is an instance-scoped PTY whose output is
// a versioned, sequence-ordered stream. The attach protocol is bidirectional:
// the server seeds a session, emits ordered output frames, and acknowledges
// input/resize; the client acknowledges output through a bounded window.

export type TerminalSessionState =
    "running" | "exited" | "killed" | "lost" | "failed";

export interface TerminalSessionDescriptor {
    cols: number;
    command?: string;
    createdAt: string;
    cwd?: string;
    generation: number;
    humanControl?: boolean;
    instance: string;
    latestSeq: number;
    name?: string;
    persistent?: boolean;
    rows: number;
    state: TerminalSessionState;
    terminalId: string;
    version: number;
    workspace?: string;
}

export interface TerminalOpenInput {
    cols: number;
    command?: string;
    cwd?: string;
    name?: string;
    persistent?: boolean;
    rows: number;
    workspace: string;
}

export interface TerminalOpenResult extends TerminalSessionDescriptor {}

export interface TerminalInspectResult {
    cols: number;
    cursor: { col: number; row: number };
    lines: string[];
    rows: number;
    seq: number;
    session: TerminalSessionDescriptor;
}

export interface TerminalAttachInput {
    fromSeq: number;
    takeover?: boolean;
    generation: number;
    terminalId: string;
}

export interface TerminalOutputFrame {
    data: string;
    seq: number;
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
    | {
          kind: "seed";
          session: TerminalSessionDescriptor;
          snapshot?: { seq: number; data: string };
      }
    | { frame: TerminalOutputFrame; kind: "output" }
    | {
          clientSeq: number;
          identity: TerminalVersionedIdentity;
          kind: "inputAccepted" | "resized";
      }
    | {
          clientSeq: number;
          humanControl: boolean;
          kind: "controlChanged";
          session: TerminalSessionDescriptor;
          snapshot?: { seq: number; data: string };
      }
    | { event: TerminalExitEvent; kind: "exit" }
    | { kind: "closed"; error?: Error; session?: TerminalSessionDescriptor };
