import type { SpawnFunction, WorkerCommandTransport } from "../../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import { DockerWorkerTransport, type DockerWorkerTransportOptions } from "../driver/WorkerTransportDriverDocker.js";
import { LocalWorkerTransport, type LocalWorkerTransportOptions } from "../driver/WorkerTransportDriverLocal.js";
import { PodmanWorkerTransport, type PodmanWorkerTransportOptions } from "../driver/WorkerTransportDriverPodman.js";
import { SshWorkerTransport, type SshWorkerTransportOptions } from "../driver/WorkerTransportDriverSsh.js";

export interface LocalWorkerTransportFactoryOptions extends Omit<LocalWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "local";
    spawnFunction?: SpawnFunction;
}

export interface SshWorkerTransportFactoryOptions extends Omit<SshWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "ssh";
    spawnFunction?: SpawnFunction;
}

export interface DockerWorkerTransportFactoryOptions
    extends Omit<DockerWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "docker";
    spawnFunction?: SpawnFunction;
}

export interface PodmanWorkerTransportFactoryOptions
    extends Omit<PodmanWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "podman";
    spawnFunction?: SpawnFunction;
}

export type WorkerTransportFactoryOptions =
    | LocalWorkerTransportFactoryOptions
    | SshWorkerTransportFactoryOptions
    | DockerWorkerTransportFactoryOptions
    | PodmanWorkerTransportFactoryOptions;

export class WorkerTransportFactory {
    static create(options: WorkerTransportFactoryOptions): WorkerCommandTransport {
        const workerBinary = new WorkerBinary();

        switch (options.type) {
            case "local":
                return new LocalWorkerTransport({ workerBinary, spawnFunction: options.spawnFunction });
            case "ssh":
                return new SshWorkerTransport({ ...options, workerBinary });
            case "docker":
                return new DockerWorkerTransport({ ...options, workerBinary });
            case "podman":
                return new PodmanWorkerTransport({ ...options, workerBinary });
        }
    }
}
