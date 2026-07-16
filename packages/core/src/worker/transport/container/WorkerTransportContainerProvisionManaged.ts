import type { InstanceContainerConfig, InstanceContainerMountConfig } from "@portable-devshell/shared";

import {
    workerTransportContainerWorkingDirectoryArgs,
    type WorkerTransportContainerProvision,
    type WorkerTransportContainerProvisionOperations
} from "./WorkerTransportContainerProvision.js";

type ManagedContainerConfig = Extract<InstanceContainerConfig, { mode: "preset" | "dockerfile" | "existingImage" }>;

interface WorkerTransportContainerProvisionManagedOptions {
    config: ManagedContainerConfig;
    keepIdUserNamespace: boolean;
    operations: WorkerTransportContainerProvisionOperations;
}

export class WorkerTransportContainerProvisionManaged implements WorkerTransportContainerProvision {
    readonly #config: ManagedContainerConfig;
    readonly #keepIdUserNamespace: boolean;
    readonly #operations: WorkerTransportContainerProvisionOperations;

    constructor(options: WorkerTransportContainerProvisionManagedOptions) {
        this.#config = options.config;
        this.#keepIdUserNamespace = options.keepIdUserNamespace;
        this.#operations = options.operations;
    }

    async ensureReady(): Promise<void> {
        const image = await this.#resolveImage();
        const status = await this.#operations.readContainerStatus(this.#config.containerName);

        if (status === "missing") {
            await this.#operations.runProviderCommand(
                "createContainer",
                this.#buildCreateArgs(image)
            );
            await this.#operations.runProviderCommand("startContainer", ["start", this.#config.containerName]);
            return;
        }

        if (status !== "running") {
            await this.#operations.runProviderCommand("startContainer", ["start", this.#config.containerName]);
        }
    }

    async isAvailable(): Promise<boolean> {
        return (await this.#operations.readContainerStatus(this.#config.containerName)) === "running";
    }

    async afterWorkerStop(): Promise<void> {
        await this.#operations.runProviderCommand(
            "stopContainer",
            ["stop", this.#config.containerName],
            { allowNonZeroExit: true }
        );
    }

    buildExecArgs(command: readonly string[], useRemoteCwd: boolean): string[] {
        return [
            "exec",
            ...workerTransportContainerWorkingDirectoryArgs(this.#operations.remoteCwd, useRemoteCwd),
            "-i",
            this.#config.containerName,
            ...command
        ];
    }

    buildShellExecArgs(commandLine: string): string[] {
        return ["exec", "-i", this.#config.containerName, "sh", "-lc", commandLine];
    }

    async #resolveImage(): Promise<string> {
        if (this.#config.mode !== "dockerfile") {
            return this.#config.image;
        }

        const tag = this.#config.build.tag ?? `${this.#config.containerName}:latest`;
        const result = await this.#operations.runProviderCommand(
            "inspectImage",
            ["image", "inspect", tag],
            { allowNonZeroExit: true }
        );

        if (result.exitCode !== 0) {
            const args = ["build", "-t", tag];
            if (this.#config.build.dockerfile !== undefined) {
                args.push("-f", this.#config.build.dockerfile);
            }
            args.push(this.#config.build.context);
            await this.#operations.runProviderCommand("buildImage", args);
        }

        return tag;
    }

    #buildCreateArgs(image: string): string[] {
        return [
            "create",
            "--name",
            this.#config.containerName,
            ...(this.#keepIdUserNamespace ? ["--userns=keep-id"] : []),
            ...(this.#config.user === undefined ? [] : ["--user", this.#config.user]),
            ...(this.#config.network === undefined ? [] : ["--network", this.#config.network]),
            ...Object.entries(this.#config.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
            ...(this.#config.mounts ?? []).flatMap((mount) => ["-v", renderContainerMount(mount)]),
            image,
            "sh",
            "-lc",
            "trap 'exit 0' TERM INT; while :; do sleep 2147483647; done"
        ];
    }
}

export function renderContainerMount(mount: InstanceContainerMountConfig): string {
    const segments = [mount.source, mount.target, mount.mode];

    if (mount.selinux === "shared") {
        segments.push("z");
    } else if (mount.selinux === "private") {
        segments.push("Z");
    }

    return segments.join(":");
}
