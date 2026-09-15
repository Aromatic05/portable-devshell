import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { SpawnFunction } from "../../command/Transport.js";
import { WorkerBinary } from "../../Binary.js";
import { WorkerTransportDriverContainerBase } from "./Base.js";

export interface WorkerTransportDriverDockerOptions {
    container: InstanceContainerConfig;
    dockerBinary?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export class WorkerTransportDriverDocker extends WorkerTransportDriverContainerBase {
    constructor(options: WorkerTransportDriverDockerOptions) {
        super({
            binary: options.dockerBinary ?? "docker",
            container: options.container,
            provider: "docker",
            spawnFunction: options.spawnFunction,
            workerBinary: options.workerBinary,
        });
    }
}
