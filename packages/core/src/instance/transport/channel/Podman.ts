import {
    DockerTransport,
    type DockerTransportOptions,
} from "./Docker.js";

export type PodmanTransportOptions = DockerTransportOptions;

export class PodmanTransport extends DockerTransport {}
