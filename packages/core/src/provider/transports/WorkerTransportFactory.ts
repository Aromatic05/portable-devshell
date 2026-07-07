import type { SpawnFunction, WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../command/WorkerBinary.js";
import { DockerWorkerTransport, type DockerWorkerTransportOptions } from "./DockerWorkerTransport.js";
import { LocalWorkerTransport, type LocalWorkerTransportOptions } from "./LocalWorkerTransport.js";
import { PodmanWorkerTransport, type PodmanWorkerTransportOptions } from "./PodmanWorkerTransport.js";
import { SshWorkerTransport, type SshWorkerTransportOptions } from "./SshWorkerTransport.js";

export interface LocalWorkerTransportFactoryOptions extends Omit<LocalWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "local";
    workerBinaryPath?: string;
    spawnFunction?: SpawnFunction;
}

export interface SshWorkerTransportFactoryOptions extends Omit<SshWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "ssh";
    workerBinaryPath?: string;
    spawnFunction?: SpawnFunction;
}

export interface DockerWorkerTransportFactoryOptions
    extends Omit<DockerWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "docker";
    workerBinaryPath?: string;
    spawnFunction?: SpawnFunction;
}

export interface PodmanWorkerTransportFactoryOptions
    extends Omit<PodmanWorkerTransportOptions, "workerBinary" | "spawnFunction"> {
    type: "podman";
    workerBinaryPath?: string;
    spawnFunction?: SpawnFunction;
}

export type WorkerTransportFactoryOptions =
    | LocalWorkerTransportFactoryOptions
    | SshWorkerTransportFactoryOptions
    | DockerWorkerTransportFactoryOptions
    | PodmanWorkerTransportFactoryOptions;

export class WorkerTransportFactory {
    static create(options: WorkerTransportFactoryOptions): WorkerCommandTransport {
        const workerBinary = new WorkerBinary(options.workerBinaryPath);

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
