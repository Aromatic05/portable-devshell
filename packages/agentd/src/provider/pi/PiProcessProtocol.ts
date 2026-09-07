import type { AgentWorkerTarget } from "../../target/AgentWorkerTarget.js";

export interface PiChildInitMessage {
    entrypoint: string;
    type: "init";
    webBasePath: string;
}

export interface PiChildAgentStartMessage {
    agentId: string;
    id: string;
    localCwd: string;
    target: AgentWorkerTarget;
    type: "agent.start";
}

export type PiChildCommandName = "abort" | "followUp" | "prompt" | "reload" | "steer" | "stop";

export interface PiChildAgentCommandMessage {
    agentId: string;
    command: PiChildCommandName;
    id: string;
    message?: string;
    type: "agent.command";
}

export interface PiChildShutdownMessage {
    id: string;
    type: "shutdown";
}

export type PiParentMessage = PiChildInitMessage
    | PiChildAgentStartMessage
    | PiChildAgentCommandMessage
    | PiChildShutdownMessage;

export interface PiChildReadyMessage {
    error?: string;
    ok: boolean;
    type: "ready";
    webUpstream?: string;
}

export interface PiChildResultMessage {
    error?: string;
    id: string;
    ok: boolean;
    type: "result";
}

export type PiChildMessage = PiChildReadyMessage | PiChildResultMessage;
