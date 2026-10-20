import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { WorkerCommandResult } from "../../execution/Command.js";
import { ContainerProvisionCompose } from "./Compose.js";
import { ContainerProvisionExisting } from "./Existing.js";
import { ContainerProvisionManaged } from "./Managed.js";
import type { ContainerAdoptionIdentity } from "./Adoption.js";

export type ContainerLifecycleStatus =
    "missing" | "running" | "stopped";

export interface ContainerProvision {
    afterWorkerStop(): Promise<void>;
    ensureReady(operation: string): Promise<void>;
    finishRuntimeRetire(): Promise<void>;
    isAvailable(): Promise<boolean>;
    prepareRuntimeRetire(): Promise<boolean>;
    retire(): Promise<void>;
}

export interface ContainerProvisionOperations {
    provider: "docker" | "podman";
    binary?: string;
    setContainerTarget?(containerId: string): void;
    readContainerStatus(
        containerName: string,
    ): Promise<ContainerLifecycleStatus>;
    runProviderCommand(
        operation: string,
        args: readonly string[],
        options?: { allowNonZeroExit?: boolean; env?: NodeJS.ProcessEnv },
    ): Promise<WorkerCommandResult>;
}

export function createContainerProvision(options: {
    adoption?: ContainerAdoptionIdentity;
    container: InstanceContainerConfig;
    keepIdUserNamespace: boolean;
    operations: ContainerProvisionOperations;
}): ContainerProvision {
    switch (options.container.mode) {
        case "preset":
        case "dockerfile":
        case "existingImage":
            return new ContainerProvisionManaged({
                config: options.container,
                keepIdUserNamespace: options.keepIdUserNamespace,
                operations: options.operations,
            });
        case "compose":
            return new ContainerProvisionCompose({
                config: options.container,
                operations: options.operations,
            });
        case "existingStoppedContainer":
            return new ContainerProvisionExisting({
                adoption: options.adoption,
                config: options.container,
                operations: options.operations,
            });
    }
}
