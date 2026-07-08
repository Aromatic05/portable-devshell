import type { InstanceContainerConfig } from "@portable-devshell/shared";

import type { SpawnFunction } from "../../command/WorkerCommandTransport.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import { ContainerWorkerTransportBase, renderContainerMount } from "./WorkerTransportDriverContainerBase.js";

export interface PodmanWorkerTransportOptions {
    container: InstanceContainerConfig;
    podmanBinary?: string;
    remoteCwd?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export class PodmanWorkerTransport extends ContainerWorkerTransportBase {
    constructor(options: PodmanWorkerTransportOptions) {
        super({
            binary: options.podmanBinary ?? "podman",
            container: options.container,
            provider: "podman",
            remoteCwd: options.remoteCwd,
            spawnFunction: options.spawnFunction,
            workerBinary: options.workerBinary
        });
    }

    protected buildComposeArgs(args: readonly string[]): string[] {
        if (this.containerConfig.mode !== "compose") {
            throw new Error("compose args are only available for compose mode");
        }

        const compose = this.containerConfig.compose;
        return [
            "compose",
            "-f",
            compose.file,
            ...(compose.projectName === undefined ? [] : ["-p", compose.projectName]),
            ...args
        ];
    }

    protected buildManagedContainerCreateArgs(image: string, containerName: string): string[] {
        const container = this.containerConfig;

        if (container.mode !== "preset" && container.mode !== "dockerfile" && container.mode !== "existingImage") {
            throw new Error("managed create args are only available for managed container modes");
        }

        return [
            "create",
            "--name",
            containerName,
            "--userns=keep-id",
            ...(container.user === undefined ? [] : ["--user", container.user]),
            ...(container.network === undefined ? [] : ["--network", container.network]),
            ...Object.entries(container.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
            ...(container.mounts ?? []).flatMap((mount) => ["-v", renderContainerMount(mount)]),
            image,
            "sh",
            "-lc",
            "trap 'exit 0' TERM INT; while :; do sleep 2147483647; done"
        ];
    }
}
