import { ContainerConnection, type ContainerConnectionOptions } from "./worker/Container.js";
import { Worker } from "./worker/index.js";

export class PodmanConnection extends ContainerConnection {
    constructor(options: Omit<ContainerConnectionOptions, "provider" | "binary"> & { binary?: string }) {
        super({ ...options, binary: options.binary ?? "podman", provider: "podman" });
    }

    protected createChannel(): PodmanChannel {
        return new PodmanChannel(this);
    }
}

export class PodmanChannel extends Worker<ContainerConnection> {}
