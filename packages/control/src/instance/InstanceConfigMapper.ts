import { InstancePaths, WorkerInstanceFactory, WorkerTransportFactory, type WorkerInstance, type WorkerInstanceConfig, type WorkerTransportFactoryOptions } from "@portable-devshell/core";
import { asInstanceName, asWorkspacePath } from "@portable-devshell/shared";

import type { ControlInstanceConfig } from "../control/config/ControlConfigTomlCodec.js";
import type { InstanceDescriptor } from "./InstanceDescriptor.js";
import { TodoService } from "../todo/TodoService.js";

export class InstanceConfigMapper {
    readonly #workerInstanceFactory: WorkerInstanceFactory;

    constructor(options?: { workerInstanceFactory?: WorkerInstanceFactory }) {
        this.#workerInstanceFactory = options?.workerInstanceFactory ?? new WorkerInstanceFactory();
    }

    map(instance: ControlInstanceConfig): InstanceDescriptor {
        const name = asInstanceName(instance.name);
        const paths = new InstancePaths(name, process.env.HOME);
        const workerHolder: { value?: WorkerInstance } = {};
        const todo = new TodoService({
            appendEvent: async (type, data) => {
                await workerHolder.value?.appendControlEvent(type, data);
            },
            filePath: paths.todoFile,
            instanceName: instance.name
        });
        const worker = this.#workerInstanceFactory.create(this.#toWorkerConfig(instance), {
            toolCallAssociationProvider: () => todo.currentAssociation()
        });
        workerHolder.value = worker;

        return {
            mcpCapabilities: instance.mcp.tools.capabilities,
            mcpGroups: instance.mcp.tools.groups,
            enabled: instance.enabled,
            mcpEnabled: instance.mcp.enabled,
            mcpPath: `/${instance.name}/mcp`,
            name: instance.name,
            todo,
            worker
        };
    }

    #toWorkerConfig(instance: ControlInstanceConfig): WorkerInstanceConfig {
        const effectiveSecurityMode = instance.security?.mode === "workspace" ? "workspace" : "disabled";

        return {
            defaultWorkspace: instance.workspace === undefined ? undefined : asWorkspacePath(instance.workspace),
            env: {
                ...instance.env,
                DEVSHELL_WORKER_INTERNAL_FILE_EDIT_MODE: instance.tools?.fileEdit?.mode ?? "text",
                DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: effectiveSecurityMode,
                DEVSHELL_WORKER_SECURITY_MODE: effectiveSecurityMode
            },
            eventBufferSize: instance.logs?.eventBufferSize,
            approvalPolicy: instance.approvalPolicy,
            toolScheduler: instance.tools?.scheduler,
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
