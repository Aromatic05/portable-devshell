import type { ControlMcpContextMode } from "@portable-devshell/shared";

import type { WorkerInstance } from "../worker/instance/Instance.js";
import type { WorkerTransportConnection } from "../worker/transport/Transport.js";

export interface InstanceDescriptor {
    enabled: boolean;
    mcpContextMode?: ControlMcpContextMode;
    mcpEnabled: boolean;
    mcpPath: string;
    modelExtensions: readonly string[];
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: WorkerTransportConnection;
    worker: WorkerInstance;
}
