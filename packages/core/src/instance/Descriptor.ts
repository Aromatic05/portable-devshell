import type { ControlMcpContextMode } from "@portable-devshell/shared";

import type { ApprovalApi } from "../approval/Api.js";
import type { TerminalBackend } from "../terminal/Backend.js";
import type { WorkerInstance } from "./runtime/index.js";
import type { TransportConnection } from "./transport/endpoint/Connection.js";

export interface InstanceDescriptor {
    approval: ApprovalApi;
    enabled: boolean;
    mcpContextMode?: ControlMcpContextMode;
    mcpEnabled: boolean;
    mcpPath: string;
    modelExtensions: readonly string[];
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: TransportConnection;
    terminal: TerminalBackend;
    worker: WorkerInstance;
}
