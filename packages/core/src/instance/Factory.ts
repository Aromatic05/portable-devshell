import { WorkerInstanceFactory } from "../worker/instance/Factory.js";
import type { WorkerInstanceConfig } from "../worker/instance/Config.js";
import { resolveWorkerHomeDirectory } from "../worker/provision/HomeDirectory.js";
import { WorkerTransportFactory } from "../worker/transport/Factory.js";
import { WorkerTransportConnection } from "../worker/transport/Transport.js";
import type { WorkerTransportFactoryOptions } from "../worker/transport/Factory.js";
import {
    asInstanceName,
    type ControlInstanceConfig,
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "./Descriptor.js";

export class InstanceFactory {
    readonly #workerInstanceFactory: WorkerInstanceFactory;

    constructor(options?: { workerInstanceFactory?: WorkerInstanceFactory }) {
        this.#workerInstanceFactory =
            options?.workerInstanceFactory ?? new WorkerInstanceFactory();
    }

    map(instance: ControlInstanceConfig): InstanceDescriptor {
        const homeDirectory = resolveWorkerHomeDirectory();
        const reverseConnection =
            instance.provider === "reverse"
                ? new WorkerTransportConnection()
                : undefined;
        const worker = this.#workerInstanceFactory.create(
            this.#toWorkerConfig(instance, reverseConnection, homeDirectory),
        );

        return {
            enabled: instance.enabled,
            mcpContextMode: instance.mcp.contextMode,
            mcpEnabled: instance.mcp.enabled,
            mcpPath: `/${instance.name}/mcp`,
            modelExtensions: [...instance.extensions.model],
            name: instance.name,
            provider: instance.provider,
            ...(reverseConnection === undefined ? {} : { reverseConnection }),
            worker,
        };
    }

    #toWorkerConfig(
        instance: ControlInstanceConfig,
        reverseConnection: WorkerTransportConnection | undefined,
        homeDirectory: string,
    ): WorkerInstanceConfig {
        const effectiveSecurityMode: "disabled" | "workspace" =
            instance.security?.mode === "workspace" ? "workspace" : "disabled";
        const common = {
            alerts: instance.alerts,
            env: {
                ...instance.env,
                DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: effectiveSecurityMode,
                DEVSHELL_WORKER_SECURITY_MODE: effectiveSecurityMode,
            },
            eventBufferSize: instance.logs?.eventBufferSize,
            auditStorage: {
                maxBytes: instance.logs?.maxBytes,
                retentionDays: instance.logs?.retentionDays,
            },
            toolScheduler: instance.tools?.scheduler,
            effectiveSecurityMode,
            homeDirectory,
            name: asInstanceName(instance.name),
        };

        if (instance.provider === "reverse") {
            return {
                ...common,
                managementMode: "selfManaged",
                transportConnection:
                    reverseConnection ??
                    fail(
                        `reverse instance ${instance.name} requires transport connection`,
                    ),
            };
        }

        return {
            ...common,
            managementMode: "controllerManaged",
            transport: WorkerTransportFactory.create(
                this.#toTransportOptions(instance),
            ),
        };
    }

    #toTransportOptions(
        instance: ControlInstanceConfig,
    ): WorkerTransportFactoryOptions {
        switch (instance.provider) {
            case "local":
                return {
                    type: "local",
                };
            case "ssh":
                return {
                    command: instance.ssh.command,
                    type: "ssh",
                };
            case "docker":
                return {
                    container: instance.container,
                    dockerBinary: instance.dockerBinary,
                    type: "docker",
                };
            case "podman":
                return {
                    container: instance.container,
                    podmanBinary: instance.podmanBinary,
                    type: "podman",
                };
            case "reverse":
                throw new Error(
                    `reverse instance ${instance.name} does not use command transport`,
                );
        }
    }
}

function fail(message: string): never {
    throw new Error(message);
}
