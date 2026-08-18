import { InstancePaths, WorkerInstanceFactory, WorkerRpcInboundConnector, WorkerTransportFactory, resolveWorkerHomeDirectory, type WorkerInstance, type WorkerInstanceConfig, type WorkerTransportFactoryOptions } from "@portable-devshell/core";
import { asInstanceName, type ControlInstanceConfig } from "@portable-devshell/shared";

import type { InstanceDescriptor } from "./InstanceDescriptor.js";
import { ContextMessageService } from "../../instance/context/ContextMessageService.js";
import { TodoService } from "../../instance/todo/TodoService.js";
import { WaitService } from "../../instance/wait/WaitService.js";
import { WorkerTerminalBackend } from "../terminal/WorkerTerminalBackend.js";

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
        const contextMessages = new ContextMessageService({
            appendEvent: async (type, data) => {
                await workerHolder.value?.appendControlEvent(type, data);
            },
            filePath: paths.contextMessagesFile,
            instanceName: instance.name
        });
        const wait = new WaitService({
            appendEvent: async (type, data) => {
                await workerHolder.value?.appendControlEvent(type, data);
            },
            filePath: paths.waitsFile,
            instanceName: instance.name
        });
        const worker = this.#workerInstanceFactory.create(this.#toWorkerConfig(instance, reverseConnector, homeDirectory), {
            toolCallAssociationProvider: (context) => todo.currentAssociation(context.ctxId)
        });
        workerHolder.value = worker;
        const terminal = new WorkerTerminalBackend({ worker });

        return {
            contextMessages,
            mcpCapabilities: instance.mcp.tools.capabilities,
            mcpGroups: instance.mcp.tools.groups,
            enabled: instance.enabled,
            mcpEnabled: instance.mcp.enabled,
            mcpPath: `/${instance.name}/mcp`,
            name: instance.name,
            provider: instance.provider,
            ...(reverseConnector === undefined ? {} : { reverseConnector }),
            terminal,
            todo,
            wait,
            worker
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
            alerts: instance.alerts,
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
                    command: instance.ssh.command,
                    type: "ssh"
                };
            case "docker":
                return {
                    container: instance.container,
                    dockerBinary: instance.dockerBinary,
                    type: "docker"
                };
            case "podman":
                return {
                    container: instance.container,
                    podmanBinary: instance.podmanBinary,
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
