import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { SpawnFunction } from "../../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import { ContainerWorkerTransportBase } from "./WorkerTransportDriverContainerBase.js";

export interface DockerWorkerTransportOptions {
    container: InstanceContainerConfig;
    dockerBinary?: string;
    remoteCwd?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export class DockerWorkerTransport extends ContainerWorkerTransportBase {
    constructor(options: DockerWorkerTransportOptions) {
        super({
            binary: options.dockerBinary ?? "docker",
            container: options.container,
            provider: "docker",
            remoteCwd: options.remoteCwd,
            spawnFunction: options.spawnFunction,
            workerBinary: options.workerBinary
        });
    }
}
