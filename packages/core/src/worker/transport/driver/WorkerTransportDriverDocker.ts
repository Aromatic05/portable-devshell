import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { SpawnFunction } from "../../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import { WorkerTransportDriverContainerBase } from "./WorkerTransportDriverContainerBase.js";

export interface WorkerTransportDriverDockerOptions {
    container: InstanceContainerConfig;
    dockerBinary?: string;
    remoteCwd?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export class WorkerTransportDriverDocker extends WorkerTransportDriverContainerBase {
    constructor(options: WorkerTransportDriverDockerOptions) {
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
