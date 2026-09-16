import type {
    SpawnFunction,
} from "./command/Transport.js";
import type { WorkerTransport } from "./Transport.js";
import { WorkerBinary } from "./Binary.js";
import {
    WorkerTransportDriverDocker,
    type WorkerTransportDriverDockerOptions,
} from "./provider/container/Docker.js";
import {
    WorkerTransportDriverLocal,
    type WorkerTransportDriverLocalOptions,
} from "./provider/Local.js";
import {
    WorkerTransportDriverPodman,
    type WorkerTransportDriverPodmanOptions,
} from "./provider/container/Podman.js";
import {
    WorkerTransportDriverSsh,
    type WorkerTransportDriverSshOptions,
} from "./provider/Ssh.js";

export interface WorkerTransportFactoryLocalOptions extends Omit<
    WorkerTransportDriverLocalOptions,
    "workerBinary" | "spawnFunction"
> {
    type: "local";
    spawnFunction?: SpawnFunction;
}

export interface WorkerTransportFactorySshOptions extends Omit<
    WorkerTransportDriverSshOptions,
    "workerBinary" | "spawnFunction"
> {
    type: "ssh";
    spawnFunction?: SpawnFunction;
}

export interface WorkerTransportFactoryDockerOptions extends Omit<
    WorkerTransportDriverDockerOptions,
    "workerBinary" | "spawnFunction"
> {
    type: "docker";
    spawnFunction?: SpawnFunction;
}

export interface WorkerTransportFactoryPodmanOptions extends Omit<
    WorkerTransportDriverPodmanOptions,
    "workerBinary" | "spawnFunction"
> {
    type: "podman";
    spawnFunction?: SpawnFunction;
}

export type WorkerTransportFactoryOptions =
    | WorkerTransportFactoryLocalOptions
    | WorkerTransportFactorySshOptions
    | WorkerTransportFactoryDockerOptions
    | WorkerTransportFactoryPodmanOptions;

export class WorkerTransportFactory {
    static create(
        options: WorkerTransportFactoryOptions,
    ): WorkerTransport {
        const workerBinary = new WorkerBinary();

        switch (options.type) {
            case "local":
                return new WorkerTransportDriverLocal({
                    workerBinary,
                    spawnFunction: options.spawnFunction,
                });
            case "ssh":
                return new WorkerTransportDriverSsh({
                    ...options,
                    workerBinary,
                });
            case "docker":
                return new WorkerTransportDriverDocker({
                    ...options,
                    workerBinary,
                });
            case "podman":
                return new WorkerTransportDriverPodman({
                    ...options,
                    workerBinary,
                });
        }
    }
}
