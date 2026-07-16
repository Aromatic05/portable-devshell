import type { InstanceSnapshot, JsonValue } from "@portable-devshell/shared";

export type TuiAttachShellProvider = "local" | "ssh" | "docker" | "podman" | "reverse";

export interface TuiAttachShellCommand {
    args: string[];
    command: string;
    cwd?: string;
    fallbackCommands?: TuiAttachShellCommand[];
    fallbackOnExitCode?: number;
    readinessCheck?: TuiAttachShellReadinessCheck;
}

export interface TuiAttachShellReadinessCheck {
    args: string[];
    command: string;
    expectedOutput: string;
}

export interface TuiAttachShellInstanceSummary {
    defaultWorkspace?: string;
    name: string;
    provider?: string;
}

export interface TuiAttachShellResolutionInput {
    configView?: Record<string, JsonValue>;
    environment?: NodeJS.ProcessEnv;
    instance: TuiAttachShellInstanceSummary;
    snapshot?: InstanceSnapshot;
}

export class TuiAttachShellResolutionError extends Error {}

export interface TuiAttachShellRunnerHooks {
    resume(): void;
    suspend(): void;
}
