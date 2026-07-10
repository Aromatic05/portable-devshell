import type { InstanceSnapshot, JsonValue } from "@portable-devshell/shared";

export type AttachShellProvider = "local" | "ssh" | "docker" | "podman";

export interface AttachShellCommand {
    args: string[];
    command: string;
    cwd?: string;
    fallbackCommands?: AttachShellCommand[];
}

export interface AttachShellInstanceSummary {
    defaultWorkspace?: string;
    name: string;
    provider?: string;
}

export interface AttachShellResolutionInput {
    configView?: Record<string, JsonValue>;
    environment?: NodeJS.ProcessEnv;
    instance: AttachShellInstanceSummary;
    snapshot?: InstanceSnapshot;
}

export class AttachShellResolutionError extends Error {}

export interface AttachShellRunnerHooks {
    resume(): void;
    suspend(): void;
}
