import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { WorkerCommandResult } from "../../command/WorkerCommandTransport.js";
import { WorkerTransportContainerProvisionCompose } from "./WorkerTransportContainerProvisionCompose.js";
import { WorkerTransportContainerProvisionExistingStopped } from "./WorkerTransportContainerProvisionExistingStopped.js";
import { WorkerTransportContainerProvisionManaged } from "./WorkerTransportContainerProvisionManaged.js";

export type WorkerTransportContainerLifecycleStatus = "missing" | "running" | "stopped";

export interface WorkerTransportContainerProvision {
    afterWorkerStop(): Promise<void>;
    buildExecArgs(command: readonly string[], useRemoteCwd: boolean): string[];
    buildShellExecArgs(commandLine: string): string[];
    ensureReady(operation: string): Promise<void>;
    isAvailable(): Promise<boolean>;
}

export interface WorkerTransportContainerProvisionOperations {
    provider: "docker" | "podman";
    readContainerStatus(containerName: string): Promise<WorkerTransportContainerLifecycleStatus>;
    remoteCwd?: string;
    runProviderCommand(
        operation: string,
        args: readonly string[],
        options?: { allowNonZeroExit?: boolean; env?: NodeJS.ProcessEnv }
    ): Promise<WorkerCommandResult>;
}

export function createWorkerTransportContainerProvision(options: {
    container: InstanceContainerConfig;
    keepIdUserNamespace: boolean;
    operations: WorkerTransportContainerProvisionOperations;
}): WorkerTransportContainerProvision {
    switch (options.container.mode) {
        case "preset":
        case "dockerfile":
        case "existingImage":
            return new WorkerTransportContainerProvisionManaged({
                config: options.container,
                keepIdUserNamespace: options.keepIdUserNamespace,
                operations: options.operations
            });
        case "compose":
            return new WorkerTransportContainerProvisionCompose({
                config: options.container,
                operations: options.operations
            });
        case "existingStoppedContainer":
            return new WorkerTransportContainerProvisionExistingStopped({
                config: options.container,
                operations: options.operations
            });
    }
}

export function workerTransportContainerWorkingDirectoryArgs(
    remoteCwd: string | undefined,
    useRemoteCwd: boolean
): string[] {
    return useRemoteCwd && remoteCwd ? ["-w", remoteCwd] : [];
}
