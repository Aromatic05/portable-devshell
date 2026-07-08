import type { InstanceSnapshot } from "./DtoInstanceSnapshot.js";

export interface InstanceCreateSchema {
    providers: readonly ["local", "ssh", "docker", "podman"];
    defaultProvider: "local" | "ssh" | "docker" | "podman";
    defaultEnabled: boolean;
    defaultMcpEnabled: boolean;
    defaultAllowTools: readonly string[];
    defaultSecurityMode: string;
}

export interface InstanceCreateDraft {
    container?: string;
    dockerBinary?: string;
    enabled?: boolean;
    host?: string;
    mcp?: {
        allowTools?: string[];
        enabled?: boolean;
    };
    name: string;
    podmanBinary?: string;
    provider: "local" | "ssh" | "docker" | "podman";
    remoteCwd?: string;
    security?: {
        mode?: string;
    };
    sshBinary?: string;
    workspace?: string;
}

export interface InstanceCreateSummary {
    container?: string;
    dockerBinary?: string;
    enabled: boolean;
    host?: string;
    mcp: {
        allowTools: string[];
        enabled: boolean;
        path: string;
    };
    name: string;
    podmanBinary?: string;
    provider: "local" | "ssh" | "docker" | "podman";
    remoteCwd?: string;
    security: {
        mode: string;
    };
    sshBinary?: string;
    workspace?: string;
}

export interface InstanceCreateResult {
    enabled: boolean;
    mcpPath?: string;
    name: string;
    snapshot?: InstanceSnapshot;
}
