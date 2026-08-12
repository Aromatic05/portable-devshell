import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { SpawnFunction } from "../../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import { WorkerTransportDriverContainerBase } from "./WorkerTransportDriverContainerBase.js";

export interface WorkerTransportDriverDockerOptions {
    container: InstanceContainerConfig;
    dockerBinary?: string;
    skillsDirectory?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export class WorkerTransportDriverDocker extends WorkerTransportDriverContainerBase {
    constructor(options: WorkerTransportDriverDockerOptions) {
        super({
            binary: options.dockerBinary ?? "docker",
            container: options.container,
            provider: "docker",
            skillsDirectory: options.skillsDirectory,
            spawnFunction: options.spawnFunction,
            workerBinary: options.workerBinary
        });
    }
}
