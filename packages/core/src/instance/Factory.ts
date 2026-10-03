import { InstancePaths } from "./Paths.js";
import { WorkerInstanceFactory } from "../worker/instance/Factory.js";
import type { WorkerInstanceConfig } from "../worker/instance/Config.js";
import type { WorkerInstance } from "../worker/instance/Instance.js";
import { resolveWorkerHomeDirectory } from "../worker/provision/HomeDirectory.js";
import { WorkerTransportFactory } from "../worker/transport/Factory.js";
import { WorkerTransportConnection } from "../worker/transport/Transport.js";
import type { WorkerTransportFactoryOptions } from "../worker/transport/Factory.js";
import {
    asInstanceName,
    type ControlInstanceConfig,
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "./Descriptor.js";
import { GoalService } from "../task/goal/Service.js";
import { TodoService } from "../task/todo/Service.js";
import { WaitService } from "../task/wait/Service.js";
import { WorkerTerminalBackend } from "../terminal/Backend.js";
import { ApprovalService } from "../approval/Service.js";
import { InstanceApprovalStore } from "../approval/Store.js";
import { ApprovalToolCallReview } from "../approval/ToolCallReview.js";

export class InstanceFactory {
    readonly #workerInstanceFactory: WorkerInstanceFactory;

    constructor(options?: { workerInstanceFactory?: WorkerInstanceFactory }) {
        this.#workerInstanceFactory =
            options?.workerInstanceFactory ?? new WorkerInstanceFactory();
    }

    map(instance: ControlInstanceConfig): InstanceDescriptor {
        const name = asInstanceName(instance.name);
        const homeDirectory = resolveWorkerHomeDirectory();
        const paths = new InstancePaths(name, homeDirectory);
        const reverseConnection =
            instance.provider === "reverse"
                ? new WorkerTransportConnection()
                : undefined;
        const workerHolder: { value?: WorkerInstance } = {};
        const todo = new TodoService({
            appendEvent: async (type, data) => {
                await workerHolder.value?.appendControlEvent(type, data);
            },
            filePath: paths.todoFile,
            instanceName: instance.name,
        });
        const goal = new GoalService({
            appendEvent: async (type, data) => {
                await workerHolder.value?.appendControlEvent(type, data);
            },
            filePath: paths.goalsFile,
            instanceName: instance.name,
        });
        const wait = new WaitService({
            appendEvent: async (type, data) => {
                await workerHolder.value?.appendControlEvent(type, data);
            },
            filePath: paths.waitsFile,
            instanceName: instance.name,
        });
        const worker = this.#workerInstanceFactory.create(
            this.#toWorkerConfig(instance, reverseConnection, homeDirectory),
        );
        workerHolder.value = worker;
        const approvalStore = new InstanceApprovalStore(
            paths.auditDatabaseFile,
            paths.legacyApprovalsFile,
        );
        const approval = new ApprovalService({
            instanceName: name,
            policy: instance.approvalPolicy,
            store: approvalStore,
            events: {
                append: async (type, data) => {
                    await worker.appendControlEvent(type, data);
                },
            },
        });
        const approvalReview = new ApprovalToolCallReview({
            service: approval,
        });
        const terminal = new WorkerTerminalBackend({ worker });

        return {
            approval,
            approvalReview: approvalReview.review,
            goal,
            mcpContextMode: instance.mcp.contextMode,
            enabled: instance.enabled,
            mcpEnabled: instance.mcp.enabled,
            mcpPath: `/${instance.name}/mcp`,
            modelExtensions: [...instance.extensions.model],
            name: instance.name,
            provider: instance.provider,
            ...(reverseConnection === undefined ? {} : { reverseConnection }),
            terminal,
            todo,
            wait,
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
