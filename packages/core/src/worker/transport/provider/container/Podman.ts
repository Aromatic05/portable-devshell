import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { SpawnFunction } from "../../command/Transport.js";
import { WorkerBinary } from "../../Binary.js";
import { WorkerTransportDriverContainerBase } from "./Base.js";

export interface WorkerTransportDriverPodmanOptions {
    container: InstanceContainerConfig;
    podmanBinary?: string;
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
            spawnFunction: options.spawnFunction,
            workerBinary: options.workerBinary,
        });
    }
}
