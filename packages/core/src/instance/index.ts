import {
    asInstanceName,
    type ControlInstanceConfig,
} from "@portable-devshell/shared";

import { createInstanceApprovalService } from "../approval/index.js";
import type { ApprovalApi } from "../approval/Api.js";
import { createInstanceTerminalBackend } from "../terminal/index.js";
import type { TerminalBackend } from "../terminal/Backend.js";
import { Instance } from "./Instance.js";
import { InstancePaths } from "./Paths.js";
import { resolveWorkerHomeDirectory } from "./runtime/provision/Home.js";
import {
    WorkerRuntimeFactory,
    type WorkerRuntimeFactoryOptions,
} from "./runtime/provision/Factory.js";
import { ReverseProvision } from "./runtime/provision/install/provider/Reverse.js";
import { WorkerInstance } from "./runtime/index.js";
import { InstanceEventBuffer } from "./runtime/supervision/Event.js";
import { WorkerCommandClient } from "./runtime/execution/Command.js";
import { WorkerProtocolClient } from "./transport/packet/Client.js";
import { InstanceStateMachine } from "./runtime/supervision/State.js";
import { TransportConnection } from "./transport/endpoint/Connection.js";
import { TransportFactory } from "./transport/endpoint/Factory.js";
import {
    resolveWorkerInstanceConfig,
    type WorkerInstanceConfig,
} from "./runtime/provision/Config.js";

export { Instance, type InstanceFields, type InstanceLease, type InstanceReferenceLease } from "./Instance.js";
export { InstanceRegistry } from "./Registry.js";

export function createInstance(config: ControlInstanceConfig): Instance {
    const homeDirectory = resolveWorkerHomeDirectory();
    const instanceName = asInstanceName(config.name);
    const paths = new InstancePaths(instanceName, homeDirectory);
    const reverse =
        config.provider === "reverse" ? new ReverseProvision() : undefined;
    const worker = createWorkerInstance(
        toWorkerConfig(config, reverse, homeDirectory),
    );
    let approvalService: ApprovalApi | undefined;
    let approvalPolicy = config.approvalPolicy;
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
    const terminal = lazyMethods(() =>
        (terminalBackend ??= createInstanceTerminalBackend(worker)),
    );

    return new Instance({
        approval,
        enabled: config.enabled,
        mcpContextMode: config.mcp.contextMode,
        mcpEnabled: config.mcp.enabled,
        mcpPath: `/${config.name}/mcp`,
        modelExtensions: [...config.extensions.model],
        name: config.name,
        provider: config.provider,
        ...(reverse === undefined
            ? {}
            : { reverseConnection: reverse.transportConnection }),
        terminal,
        worker,
    });
}

function createWorkerInstance(config: WorkerInstanceConfig): WorkerInstance {
    const resolved = resolveWorkerInstanceConfig(config);
    const transportConnection = resolved.transportConnection;
    const workerHost = `${resolved.name}-worker`;
    const endpoint = TransportFactory.createEndpoint(
        transportConnection,
        resolved.name,
        workerHost,
    );
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

function toWorkerConfig(
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
        toRuntimeOptions(instance),
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

function toRuntimeOptions(
    instance: ControlInstanceConfig,
): WorkerRuntimeFactoryOptions {
    switch (instance.provider) {
        case "local":
            return { type: "local" };
        case "ssh":
            return { command: instance.ssh.command, type: "ssh" };
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
