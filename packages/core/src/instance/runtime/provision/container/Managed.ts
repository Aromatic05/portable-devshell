import type {
    InstanceContainerConfig,
    InstanceContainerMountConfig,
} from "@portable-devshell/shared";

import {
    type ContainerProvision,
    type ContainerProvisionOperations,
} from "./Provision.js";

type ManagedContainerConfig = Extract<
    InstanceContainerConfig,
    { mode: "preset" | "dockerfile" | "existingImage" }
>;

interface ContainerProvisionManagedOptions {
    config: ManagedContainerConfig;
    keepIdUserNamespace: boolean;
    operations: ContainerProvisionOperations;
}

export class ContainerProvisionManaged implements ContainerProvision {
    readonly #config: ManagedContainerConfig;
    readonly #keepIdUserNamespace: boolean;
    readonly #operations: ContainerProvisionOperations;

    constructor(options: ContainerProvisionManagedOptions) {
        this.#config = options.config;
        this.#keepIdUserNamespace = options.keepIdUserNamespace;
        this.#operations = options.operations;
    }

    async ensureReady(): Promise<void> {
        const image = await this.#resolveImage();
        const status = await this.#operations.readContainerStatus(
            this.#config.containerName,
        );

        if (status === "missing") {
            await this.#operations.runProviderCommand(
                "createContainer",
                this.#buildCreateArgs(image),
            );
            await this.#operations.runProviderCommand("startContainer", [
                "start",
                this.#config.containerName,
            ]);
            return;
        }

        if (status !== "running") {
            await this.#operations.runProviderCommand("startContainer", [
                "start",
                this.#config.containerName,
            ]);
        }
    }

    async isAvailable(): Promise<boolean> {
        return (
            (await this.#operations.readContainerStatus(
                this.#config.containerName,
            )) === "running"
        );
    }

    async prepareRuntimeRetire(): Promise<boolean> {
        return await this.isAvailable();
    }

    async finishRuntimeRetire(): Promise<void> {}

    async afterWorkerStop(): Promise<void> {
        await this.#operations.runProviderCommand(
            "stopContainer",
            ["stop", this.#config.containerName],
            { allowNonZeroExit: true },
        );
    }

    async retire(): Promise<void> {
        if (
            (await this.#operations.readContainerStatus(
                this.#config.containerName,
            )) === "missing"
        ) {
            return;
        }
        await this.#operations.runProviderCommand("removeContainer", [
            "rm",
            "-f",
            this.#config.containerName,
        ]);
    }



    async #resolveImage(): Promise<string> {
        if (this.#config.mode !== "dockerfile") {
            return this.#config.image;
        }

        const tag =
            this.#config.build.tag ?? `${this.#config.containerName}:latest`;
        const result = await this.#operations.runProviderCommand(
            "inspectImage",
            ["image", "inspect", tag],
            { allowNonZeroExit: true },
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

    #containerMounts(): InstanceContainerMountConfig[] {
        return [...(this.#config.mounts ?? [])];
    }

    #buildCreateArgs(image: string): string[] {
        return [
            "create",
            "--name",
            this.#config.containerName,
            ...(this.#keepIdUserNamespace ? ["--userns=keep-id"] : []),
            ...(this.#config.user === undefined
                ? []
                : ["--user", this.#config.user]),
            ...(this.#config.network === undefined
                ? []
                : ["--network", this.#config.network]),
            ...Object.entries(this.#config.env ?? {}).flatMap(
                ([key, value]) => ["-e", `${key}=${value}`],
            ),
            ...this.#containerMounts().flatMap((mount) => [
                "-v",
                renderContainerMount(mount),
            ]),
            image,
            "sh",
            "-lc",
            "trap 'exit 0' TERM INT; while :; do sleep 2147483647; done",
        ];
    }
}

export function renderContainerMount(
    mount: InstanceContainerMountConfig,
): string {
    const segments = [mount.source, mount.target, mount.mode];

    if (mount.selinux === "shared") {
        segments.push("z");
    } else if (mount.selinux === "private") {
        segments.push("Z");
    }

    return segments.join(":");
}
