import { TransportFactory } from "../../transport/endpoint/Factory.js";
import type { InstanceContainerConfig } from "@portable-devshell/shared";

import { WorkerBinary } from "../Binary.js";
import type { WorkerRuntime } from "../execution/Command.js";
import { type SpawnFunction } from "../../transport/endpoint/channel/worker/Command.js";
import {
    ContainerExecution,
} from "../execution/provider/Container.js";
import {
    LocalExecution,
    type LocalExecutionOptions,
} from "../execution/provider/Local.js";
import {
    SshExecution,
    type SshExecutionOptions,
} from "../execution/provider/Ssh.js";
import { ContainerInstall } from "./install/provider/Container.js";
import type { ContainerAdoptionIdentity } from "./container/Adoption.js";

export interface WorkerRuntimeFactoryLocalOptions extends Omit<
    LocalExecutionOptions,
    "install" | "workerBinary" | "spawnFunction"
> {
    type: "local";
    spawnFunction?: SpawnFunction;
}

export interface WorkerRuntimeFactorySshOptions extends Omit<
    SshExecutionOptions,
    "install" | "workerBinary" | "spawnFunction"
> {
    type: "ssh";
    spawnFunction?: SpawnFunction;
}

export interface WorkerRuntimeFactoryDockerOptions {
    type: "docker";
    container: InstanceContainerConfig;
    adoption?: ContainerAdoptionIdentity;
    dockerBinary?: string;
    spawnFunction?: SpawnFunction;
}

export interface WorkerRuntimeFactoryPodmanOptions {
    type: "podman";
    container: InstanceContainerConfig;
    adoption?: ContainerAdoptionIdentity;
    podmanBinary?: string;
    spawnFunction?: SpawnFunction;
}

export type WorkerRuntimeFactoryOptions =
    | WorkerRuntimeFactoryLocalOptions
    | WorkerRuntimeFactorySshOptions
    | WorkerRuntimeFactoryDockerOptions
    | WorkerRuntimeFactoryPodmanOptions;

export class WorkerRuntimeFactory {
    static create(options: WorkerRuntimeFactoryOptions): WorkerRuntime {
        const workerBinary = new WorkerBinary();

        switch (options.type) {
            case "local":
                return new LocalExecution({
                    ...options,
                    connection: options.connection ?? TransportFactory.create(options).getConnection(),
                    workerBinary,
                });
            case "ssh":
                return new SshExecution({
                    ...options,
                    connection: TransportFactory.create(options).getConnection(),
                    workerBinary,
                });
            case "docker":
                return new ContainerExecution(
                    new ContainerInstall({
                        connection: TransportFactory.create(options).getConnection(),
                        binary: options.dockerBinary ?? "docker",
                        container: options.container,
                        adoption: options.adoption,
                        provider: "docker",
                        spawnFunction: options.spawnFunction,
                        workerBinary,
                    }),
                );
            case "podman":
                return new ContainerExecution(
                    new ContainerInstall({
                        connection: TransportFactory.create(options).getConnection(),
                        binary: options.podmanBinary ?? "podman",
                        container: options.container,
                        adoption: options.adoption,
                        keepIdUserNamespace: true,
                        provider: "podman",
                        spawnFunction: options.spawnFunction,
                        workerBinary,
                    }),
                );
        }
    }
}
