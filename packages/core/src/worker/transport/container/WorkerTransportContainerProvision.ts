import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { WorkerCommandResult } from "../../command/WorkerCommandTransport.js";
import { WorkerTransportContainerProvisionCompose } from "./WorkerTransportContainerProvisionCompose.js";
import { WorkerTransportContainerProvisionExistingStopped } from "./WorkerTransportContainerProvisionExistingStopped.js";
import { WorkerTransportContainerProvisionManaged } from "./WorkerTransportContainerProvisionManaged.js";

export type WorkerTransportContainerLifecycleStatus = "missing" | "running" | "stopped";

export interface WorkerTransportContainerProvision {
    afterWorkerStop(): Promise<void>;
    buildExecArgs(
        command: readonly string[],
        environmentKeys?: readonly string[]
    ): string[];
    buildShellExecArgs(commandLine: string): string[];
    ensureReady(operation: string): Promise<void>;
    finishRuntimeRetire(): Promise<void>;
    isAvailable(): Promise<boolean>;
    prepareRuntimeRetire(): Promise<boolean>;
    retire(): Promise<void>;
}

export interface WorkerTransportContainerProvisionOperations {
    provider: "docker" | "podman";
    readContainerStatus(containerName: string): Promise<WorkerTransportContainerLifecycleStatus>;
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

export function workerTransportContainerEnvironmentArgs(
    environmentKeys: readonly string[] | undefined
): string[] {
    return (environmentKeys ?? []).flatMap((key) => ["-e", key]);
}
