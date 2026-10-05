import { ContainerConnection, type ContainerConnectionOptions } from "./worker/Container.js";
import { Worker } from "./worker/index.js";

export class DockerConnection extends ContainerConnection {
    constructor(options: Omit<ContainerConnectionOptions, "provider" | "binary"> & { binary?: string }) {
        super({ ...options, binary: options.binary ?? "docker", provider: "docker" });
    }

    protected createChannel(): DockerChannel {
        return new DockerChannel(this);
    }
}

export class DockerChannel extends Worker<ContainerConnection> {}
