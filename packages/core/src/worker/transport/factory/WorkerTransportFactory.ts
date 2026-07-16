import type { SpawnFunction, WorkerCommandTransport } from "../../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import { WorkerTransportDriverDocker, type WorkerTransportDriverDockerOptions } from "../driver/WorkerTransportDriverDocker.js";
import { WorkerTransportDriverLocal, type WorkerTransportDriverLocalOptions } from "../driver/WorkerTransportDriverLocal.js";
import { WorkerTransportDriverPodman, type WorkerTransportDriverPodmanOptions } from "../driver/WorkerTransportDriverPodman.js";
import { WorkerTransportDriverSsh, type WorkerTransportDriverSshOptions } from "../driver/WorkerTransportDriverSsh.js";

export interface WorkerTransportFactoryLocalOptions extends Omit<WorkerTransportDriverLocalOptions, "workerBinary" | "spawnFunction"> {
    type: "local";
    spawnFunction?: SpawnFunction;
}

export interface WorkerTransportFactorySshOptions extends Omit<WorkerTransportDriverSshOptions, "workerBinary" | "spawnFunction"> {
    type: "ssh";
    spawnFunction?: SpawnFunction;
}

export interface WorkerTransportFactoryDockerOptions
    extends Omit<WorkerTransportDriverDockerOptions, "workerBinary" | "spawnFunction"> {
    type: "docker";
    spawnFunction?: SpawnFunction;
}

export interface WorkerTransportFactoryPodmanOptions
    extends Omit<WorkerTransportDriverPodmanOptions, "workerBinary" | "spawnFunction"> {
    type: "podman";
    spawnFunction?: SpawnFunction;
}

export type WorkerTransportFactoryOptions =
    | WorkerTransportFactoryLocalOptions
    | WorkerTransportFactorySshOptions
    | WorkerTransportFactoryDockerOptions
    | WorkerTransportFactoryPodmanOptions;

export class WorkerTransportFactory {
    static create(options: WorkerTransportFactoryOptions): WorkerCommandTransport {
        const workerBinary = new WorkerBinary();

        switch (options.type) {
            case "local":
                return new WorkerTransportDriverLocal({ workerBinary, spawnFunction: options.spawnFunction });
            case "ssh":
                return new WorkerTransportDriverSsh({ ...options, workerBinary });
            case "docker":
                return new WorkerTransportDriverDocker({ ...options, workerBinary });
            case "podman":
                return new WorkerTransportDriverPodman({ ...options, workerBinary });
        }
    }
}
