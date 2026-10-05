import type { WorkerInstanceConfig } from "./runtime/provision/Config.js";
import type { ApprovalApi } from "../approval/Api.js";
import { createInstanceApprovalService } from "../approval/Factory.js";
import type { TerminalBackend } from "../terminal/Backend.js";
import { createInstanceTerminalBackend } from "../terminal/Factory.js";
import { resolveWorkerHomeDirectory } from "./runtime/provision/Home.js";
import {
    WorkerRuntimeFactory,
    type WorkerRuntimeFactoryOptions,
} from "./runtime/provision/Factory.js";
import { ReverseProvision } from "./runtime/provision/install/provider/Reverse.js";
import { TransportConnection } from "./transport/endpoint/Connection.js";
import { TransportFactory } from "./transport/endpoint/Factory.js";
import {
    asInstanceName,
    type ControlInstanceConfig,
    type ControlConfig,
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "./Descriptor.js";
import { InstanceRegistry } from "./Registry.js";
import { InstancePaths } from "./Paths.js";

export class InstanceFactory {
    readonly #workerInstanceFactory: WorkerInstanceFactory;

    constructor(options?: { workerInstanceFactory?: WorkerInstanceFactory }) {
        this.#workerInstanceFactory =
            options?.workerInstanceFactory ?? new WorkerInstanceFactory();
    }

    map(instance: ControlInstanceConfig): InstanceDescriptor {
        const homeDirectory = resolveWorkerHomeDirectory();
        const instanceName = asInstanceName(instance.name);
        const paths = new InstancePaths(instanceName, homeDirectory);
        const reverse =
            instance.provider === "reverse"
                ? new ReverseProvision()
                : undefined;
        const worker = this.#workerInstanceFactory.create(
            this.#toWorkerConfig(instance, reverse, homeDirectory),
        );
        let approvalService: ApprovalApi | undefined;
        let approvalPolicy = instance.approvalPolicy;
        let terminalBackend: TerminalBackend | undefined;
        const approval = lazyMethods(
            () =>
                (approvalService ??= createInstanceApprovalService({
                    appendEvent: async (type, data) =>
                        await worker.appendControlEvent(type, data),
                    instanceName,
                    paths,
                    policy: approvalPolicy,
                })),
            {
                close: () => approvalService?.close(),
                setPolicy: (policy) => {
                    approvalPolicy = policy;
                    approvalService?.setPolicy(policy);
                },
            },
        );
        const terminal = lazyMethods(
            () =>
                (terminalBackend ??= createInstanceTerminalBackend(worker)),
        );

        return {
            approval,
            enabled: instance.enabled,
            mcpContextMode: instance.mcp.contextMode,
            mcpEnabled: instance.mcp.enabled,
            mcpPath: `/${instance.name}/mcp`,
            modelExtensions: [...instance.extensions.model],
            name: instance.name,
            provider: instance.provider,
            ...(reverse === undefined
                ? {}
                : { reverseConnection: reverse.transportConnection }),
            terminal,
            worker,
        };
    }

    #toWorkerConfig(
        instance: ControlInstanceConfig,
        reverse: ReverseProvision | undefined,
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
            effectiveSecurityMode,
            homeDirectory,
            name: asInstanceName(instance.name),
        };

        if (instance.provider === "reverse") {
            if (reverse === undefined)
                throw new Error(
                    `reverse instance ${instance.name} requires provision`,
                );
            return reverse.createConfig(common);
        }

        const provider = WorkerRuntimeFactory.create(
            this.#toRuntimeOptions(instance),
        );
        const transportConnection = new TransportConnection(
            async () =>
                await provider.connectChannel({
                    env: common.env,
                    instanceName: common.name,
                }),
        );
        return {
            ...common,
            managementMode: "controllerManaged",
            runtime: provider,
            transportConnection,
        };
    }

    #toRuntimeOptions(
        instance: ControlInstanceConfig,
    ): WorkerRuntimeFactoryOptions {
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

function lazyMethods<T extends object>(
    load: () => T,
    overrides: Partial<T> = {},
): T {
    return new Proxy(overrides as T, {
        get(target, property) {
            if (Reflect.has(target, property))
                return Reflect.get(target, property);
            const loaded = load();
            const value = Reflect.get(loaded, property);
            return typeof value === "function" ? value.bind(loaded) : value;
        },
    });
}

import { InstanceEventBuffer } from "./runtime/supervision/Event.js";
import { WorkerCommandClient } from "./runtime/execution/Command.js";
import { WorkerProtocolClient } from "./transport/packet/Client.js";
import { InstanceStateMachine } from "./runtime/supervision/State.js";
import { WorkerInstance } from "./runtime/index.js";
import { resolveWorkerInstanceConfig } from "./runtime/provision/Config.js";

export class WorkerInstanceFactory {
    create(config: WorkerInstanceConfig): WorkerInstance {
        const resolved = resolveWorkerInstanceConfig(config);
        const transportConnection = resolved.transportConnection;
        const workerHost = `${resolved.name}-worker`;
        const endpoint = TransportFactory.createEndpoint(transportConnection, resolved.name, workerHost);
        const protocolClient = new WorkerProtocolClient(endpoint, workerHost);
        return new WorkerInstance({
            commandClient:
                resolved.runtime === undefined
                    ? undefined
                    : new WorkerCommandClient(
                          resolved.runtime,
                          resolved.name,
                          resolved.env,
                      ),
            config: resolved,
            eventBuffer: new InstanceEventBuffer(
                resolved.name,
                resolved.eventBufferSize,
            ),
            endpoint,
            protocolClient,
            stateMachine: new InstanceStateMachine(resolved.name),
            transportConnection,
        });
    }

}

export class InstanceRegistryFactory {
    readonly #mapper: InstanceFactory;

    constructor(options?: { mapper?: InstanceFactory }) {
        this.#mapper = options?.mapper ?? new InstanceFactory();
    }

    build(config: ControlConfig): InstanceRegistry {
        return new InstanceRegistry(
            config.instances
                .filter((instance) => instance.enabled)
                .map((instance) => this.#mapper.map(instance)),
        );
    }
}
