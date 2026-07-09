import { WorkerInstanceFactory, WorkerTransportFactory, type WorkerInstanceConfig, type WorkerTransportFactoryOptions } from "@portable-devshell/core";
import { asInstanceName, asWorkspacePath } from "@portable-devshell/shared";

import type { ControlInstanceConfig } from "../control/config/ControlConfigTomlCodec.js";
import type { InstanceDescriptor } from "./InstanceDescriptor.js";

export class InstanceConfigMapper {
    readonly #workerInstanceFactory: WorkerInstanceFactory;

    constructor(options?: { workerInstanceFactory?: WorkerInstanceFactory }) {
        this.#workerInstanceFactory = options?.workerInstanceFactory ?? new WorkerInstanceFactory();
    }

    map(instance: ControlInstanceConfig): InstanceDescriptor {
        const worker = this.#workerInstanceFactory.create(this.#toWorkerConfig(instance));

        return {
            allowTools: instance.mcp.allowTools,
            mcpEnabled: instance.mcp.enabled,
            mcpPath: `/${instance.name}/mcp`,
            name: instance.name,
            worker
        };
    }

    #toWorkerConfig(instance: ControlInstanceConfig): WorkerInstanceConfig {
        const effectiveSecurityMode = instance.security?.mode === "workspace" ? "workspace" : "disabled";

        return {
            allowTools: instance.mcp.allowTools,
            defaultWorkspace: instance.workspace === undefined ? undefined : asWorkspacePath(instance.workspace),
            env: {
                ...instance.env,
                DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: effectiveSecurityMode,
                DEVSHELL_WORKER_SECURITY_MODE: effectiveSecurityMode
            },
            eventBufferSize: instance.logs?.eventBufferSize,
            approvalPolicy: instance.approvalPolicy,
            effectiveSecurityMode,
            homeDirectory: process.env.HOME,
            name: asInstanceName(instance.name),
            transport: WorkerTransportFactory.create(this.#toTransportOptions(instance))
        };
    }

    #toTransportOptions(instance: ControlInstanceConfig): WorkerTransportFactoryOptions {
        switch (instance.provider) {
            case "local":
                return {
                    type: "local"
                };
            case "ssh":
                return {
                    command: instance.ssh?.command ?? fail(`ssh instance ${instance.name} requires ssh.command`),
                    workspace: instance.workspace,
                    type: "ssh"
                };
            case "docker":
                return {
                    container: instance.container ?? fail(`docker instance ${instance.name} requires container`),
                    dockerBinary: instance.dockerBinary,
                    remoteCwd: instance.workspace,
                    type: "docker"
                };
            case "podman":
                return {
                    container: instance.container ?? fail(`podman instance ${instance.name} requires container`),
                    podmanBinary: instance.podmanBinary,
                    remoteCwd: instance.workspace,
                    type: "podman"
                };
        }
    }
}

function fail(message: string): never {
    throw new Error(message);
}
