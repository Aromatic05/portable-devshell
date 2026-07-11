import type { ToolAccess } from "../tool/DtoToolDefinition.js";
import type { InstanceSnapshot } from "./DtoInstanceSnapshot.js";

export type InstanceContainerMode =
    | "preset"
    | "dockerfile"
    | "compose"
    | "existingImage"
    | "existingStoppedContainer";

export type InstanceContainerMountMode = "ro" | "rw";
export type InstanceContainerMountSelinuxMode = "private" | "shared";

export interface InstanceContainerMountConfig {
    mode: InstanceContainerMountMode;
    selinux?: InstanceContainerMountSelinuxMode;
    source: string;
    target: string;
}

export interface InstanceContainerPresetSchema {
    image: string;
    preset: string;
}

export interface InstanceContainerManagedConfig {
    containerName: string;
    env?: Record<string, string>;
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}

export interface InstanceContainerPresetConfig {
    containerName: string;
    env?: Record<string, string>;
    image: string;
    mode: "preset";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    preset: string;
    user?: string;
}

export interface InstanceContainerDockerfileConfig {
    build: {
        context: string;
        dockerfile?: string;
        tag?: string;
    };
    containerName: string;
    env?: Record<string, string>;
    mode: "dockerfile";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}

export interface InstanceContainerComposeConfig {
    compose: {
        file: string;
        projectName?: string;
        service: string;
    };
    mode: "compose";
}

export interface InstanceContainerExistingImageConfig {
    containerName: string;
    env?: Record<string, string>;
    image: string;
    mode: "existingImage";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}

export interface InstanceContainerExistingStoppedContainerConfig {
    adoptLifecycle?: boolean;
    containerName: string;
    mode: "existingStoppedContainer";
}

export type InstanceContainerConfig =
    | InstanceContainerPresetConfig
    | InstanceContainerDockerfileConfig
    | InstanceContainerComposeConfig
    | InstanceContainerExistingImageConfig
    | InstanceContainerExistingStoppedContainerConfig;

export interface InstanceCreateSchema {
    container: {
        defaultMode: InstanceContainerMode;
        modes: readonly [
            "preset",
            "dockerfile",
            "compose",
            "existingImage",
            "existingStoppedContainer"
        ];
        presets: readonly InstanceContainerPresetSchema[];
    };
    providers: readonly ["local", "ssh", "docker", "podman"];
    defaultProvider: "local" | "ssh" | "docker" | "podman";
    defaultEnabled: boolean;
    defaultMcpEnabled: boolean;
    defaultMcpCapabilities: readonly ToolAccess[];
    defaultMcpGroups: readonly string[];
    defaultSecurityMode: string;
}

export interface InstanceCreateDraft {
    container?: InstanceContainerConfig;
    dockerBinary?: string;
    enabled?: boolean;
    mcp?: {
        enabled?: boolean;
        tools?: {
            capabilities?: ToolAccess[];
            groups?: string[];
        };
    };
    name: string;
    podmanBinary?: string;
    provider: "local" | "ssh" | "docker" | "podman";
    security?: {
        mode?: string;
    };
    ssh?: {
        command?: string;
    };
    workspace?: string;
}

export interface InstanceCreateSummary {
    container?: InstanceContainerConfig;
    dockerBinary?: string;
    enabled: boolean;
    mcp: {
        enabled: boolean;
        path: string;
        tools: {
            capabilities: ToolAccess[];
            groups: string[];
        };
    };
    name: string;
    podmanBinary?: string;
    provider: "local" | "ssh" | "docker" | "podman";
    security: {
        mode: string;
    };
    ssh?: {
        command?: string;
    };
    workspace?: string;
}

export interface InstanceCreateResult {
    enabled: boolean;
    mcpPath?: string;
    name: string;
    snapshot?: InstanceSnapshot;
}
