import { InstancePaths, WorkerInstanceFactory, WorkerRpcInboundConnector, WorkerTransportFactory, resolveWorkerHomeDirectory, type WorkerInstance, type WorkerInstanceConfig, type WorkerTransportFactoryOptions } from "@portable-devshell/core";
import { asInstanceName, asWorkspacePath } from "@portable-devshell/shared";

import type { ControlInstanceConfig } from "../modules/config/config/codec/ConfigTomlCodec.js";
import type { InstanceDescriptor } from "../modules/instance/InstanceDescriptor.js";
import { TodoService } from "../modules/todo/TodoService.js";

export class InstanceFactory {
    readonly #workerInstanceFactory: WorkerInstanceFactory;

    constructor(options?: { workerInstanceFactory?: WorkerInstanceFactory }) {
        this.#workerInstanceFactory = options?.workerInstanceFactory ?? new WorkerInstanceFactory();
    }

    map(instance: ControlInstanceConfig): InstanceDescriptor {
        const name = asInstanceName(instance.name);
        const homeDirectory = resolveWorkerHomeDirectory();
        const paths = new InstancePaths(name, homeDirectory);
        const reverseConnector = instance.provider === "reverse" ? new WorkerRpcInboundConnector() : undefined;
        const workerHolder: { value?: WorkerInstance } = {};
        const todo = new TodoService({
            appendEvent: async (type, data) => {
                await workerHolder.value?.appendControlEvent(type, data);
            },
            filePath: paths.todoFile,
            instanceName: instance.name
        });
        const worker = this.#workerInstanceFactory.create(this.#toWorkerConfig(instance, reverseConnector, homeDirectory), {
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
            provider: instance.provider,
            ...(reverseConnector === undefined ? {} : { reverseConnector }),
            todo,
            worker,
            workspace: instance.workspace
        };
    }

    #toWorkerConfig(
        instance: ControlInstanceConfig,
        reverseConnector: WorkerRpcInboundConnector | undefined,
        homeDirectory: string
    ): WorkerInstanceConfig {
        const effectiveSecurityMode: "disabled" | "workspace" =
            instance.security?.mode === "workspace" ? "workspace" : "disabled";
        const common = {
            defaultWorkspace: instance.workspace === undefined ? undefined : asWorkspacePath(instance.workspace),
            env: {
                ...instance.env,
                    DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: effectiveSecurityMode,
                DEVSHELL_WORKER_SECURITY_MODE: effectiveSecurityMode
            },
            eventBufferSize: instance.logs?.eventBufferSize,
            auditStorage: {
                maxBytes: instance.logs?.maxBytes,
                retentionDays: instance.logs?.retentionDays
            },
            approvalPolicy: instance.approvalPolicy,
            toolScheduler: instance.tools?.scheduler,
            effectiveSecurityMode,
            homeDirectory,
            name: asInstanceName(instance.name)
        };

        if (instance.provider === "reverse") {
            return {
                ...common,
                managementMode: "selfManaged",
                rpcConnector: reverseConnector ?? fail(`reverse instance ${instance.name} requires connector`)
            };
        }

        return {
            ...common,
            managementMode: "controllerManaged",
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
            case "reverse":
                throw new Error(`reverse instance ${instance.name} does not use command transport`);
        }
    }
}

function fail(message: string): never {
    throw new Error(message);
}
