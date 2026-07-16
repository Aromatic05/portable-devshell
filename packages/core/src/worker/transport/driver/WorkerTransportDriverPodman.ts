import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { SpawnFunction } from "../../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import { WorkerTransportDriverContainerBase } from "./WorkerTransportDriverContainerBase.js";

export interface WorkerTransportDriverPodmanOptions {
    container: InstanceContainerConfig;
    podmanBinary?: string;
    remoteCwd?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export class WorkerTransportDriverPodman extends WorkerTransportDriverContainerBase {
    constructor(options: WorkerTransportDriverPodmanOptions) {
        super({
            binary: options.podmanBinary ?? "podman",
            container: options.container,
            keepIdUserNamespace: true,
            provider: "podman",
            remoteCwd: options.remoteCwd,
            spawnFunction: options.spawnFunction,
            workerBinary: options.workerBinary
        });
    }
}
