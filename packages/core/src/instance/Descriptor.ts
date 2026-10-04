import type { TerminalBackend } from "../terminal/Backend.js";
import type { WorkerInstance } from "../worker/instance/Instance.js";
import type { WorkerTransportConnection } from "../worker/transport/Transport.js";
import type { ControlMcpContextMode } from "@portable-devshell/shared";
import type { ApprovalApi } from "../approval/Api.js";
import type { TaskApi } from "../task/Api.js";

export interface InstanceDescriptor {
    approval: ApprovalApi;
    enabled: boolean;
    mcpContextMode?: ControlMcpContextMode;
    mcpEnabled: boolean;
    mcpPath: string;
    modelExtensions: readonly string[];
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: WorkerTransportConnection;
    task: TaskApi;
    terminal?: TerminalBackend;
    worker: WorkerInstance;
}
