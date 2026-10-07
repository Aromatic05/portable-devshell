import {
    asInstanceName,
    type ControlHostDefinition,
    type ControlInstanceConfig,
    type ControlPortDefinition,
} from "@portable-devshell/shared";

import { createAuditRuntime } from "../../audit/index.js";
import type { InstanceEventPort } from "../Api.js";
import type { WorkerInstance } from "../runtime/Api.js";
import { TransportConnection } from "../transport/endpoint/Connection.js";
import { ReverseProvision } from "../runtime/provision/install/provider/Reverse.js";
import { WorkerInstance as WorkerRuntime } from "../runtime/index.js";
import { WorkerCommandClient } from "../runtime/execution/Command.js";
import { WorkerProtocolClient } from "../transport/packet/Client.js";
import { InstanceStateMachine } from "../runtime/supervision/State.js";
import { TransportFactory } from "../transport/endpoint/Factory.js";
import { resolveWorkerInstanceConfig, type WorkerInstanceConfig } from "../runtime/provision/Config.js";
import { WorkerRuntimeFactory, type WorkerRuntimeFactoryOptions } from "../runtime/provision/Factory.js";
import { InstancePaths } from "./Paths.js";
import { InstanceGeneration } from "./Generation.js";
import { InstanceWorkerOwnership } from "./Ownership.js";
import { toInstanceConfig, type InstanceConfig } from "./Config.js";
import {
    createInstanceEventLog,
    InstanceState,
} from "./State.js";
import { createInstanceHost } from "../Route.js";

export interface InstanceFields {
    config: InstanceConfig;
    paths: InstancePaths;
    state: InstanceState;
    worker: WorkerInstance;
}

export class Instance {
    readonly #paths: InstancePaths;
    readonly #worker: WorkerInstance;
    readonly #state: InstanceState;
    readonly #generation: InstanceGeneration;
    readonly #ownership: InstanceWorkerOwnership;
    #closePromise?: Promise<void>;
    #config: InstanceConfig;
    #retirePromise?: Promise<void>;

    static create(config: ControlInstanceConfig): Instance {
        const instanceName = asInstanceName(config.name);
        const paths = new InstancePaths(instanceName);
        const reverse =
            config.provider === "reverse" ? new ReverseProvision() : undefined;
        const audit = createAuditRuntime({
            eventBufferSize: config.logs?.eventBufferSize ?? 1024,
            filePath: paths.auditDatabaseFile,
            instanceName,
        });
        let instance!: Instance;
        let state!: InstanceState;
        const eventLog = createInstanceEventLog(
            audit,
            instanceName,
            async () => {
                await state.handleReadyChanged();
            },
        );
        const { protocolClient, worker } = createWorkerInstance(
            toWorkerConfig(config, reverse, paths.homeDirectory),
            eventLog.port,
        );
        state = new InstanceState({
            audit,
            config,
            eventLog,
            instanceName,
            paths,
            protocolClient,
            resolveInstance: () => instance,
            worker,
        });
        instance = new Instance({
            config: toInstanceConfig(config),
            paths,
            state,
            worker,
        });
        return instance;
    }

    constructor(fields: InstanceFields) {
        this.#paths = fields.paths;
        this.#worker = fields.worker;
        this.#state = fields.state;
        this.#config = fields.config;
        this.#generation = new InstanceGeneration(this);
        this.#ownership = new InstanceWorkerOwnership(
            this,
            fields.worker,
            this.#generation,
        );
    }

    get config(): InstanceConfig {
        return this.#config;
    }

    get worker(): WorkerInstance {
        return this.#worker;
    }

    get state(): InstanceState {
        return this.#state;
    }

    get generation(): InstanceGeneration {
        return this.#generation;
    }

    get ownership(): InstanceWorkerOwnership {
        return this.#ownership;
    }

    get paths(): InstancePaths {
        return this.#paths;
    }

    update(instance: ControlInstanceConfig): void {
        this.#config = toInstanceConfig(instance);
        this.#state.approval.setPolicy(instance.approvalPolicy);
    }

    host(extensionPorts: readonly ControlPortDefinition[] = []): ControlHostDefinition {
        return createInstanceHost({ descriptor: this, extensionPorts });
    }

    connectionClosed(connectionId: string): void {
        this.#state.subscriptions.unsubscribeConnection(connectionId);
    }

    retire(): Promise<void> {
        if (this.#retirePromise !== undefined) return this.#retirePromise;
        this.#generation.beginRetirement();
        const retirement = Promise.resolve().then(async () => await this.#retire());
        this.#retirePromise = retirement;
        void retirement.catch(() => {
            if (this.#retirePromise === retirement) this.#retirePromise = undefined;
        });
        return retirement;
    }

    close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        const closing = Promise.resolve().then(async () => await this.#close());
        this.#closePromise = closing;
        void closing.catch(() => {
            if (this.#closePromise === closing) this.#closePromise = undefined;
        });
        return closing;
    }

    async #retire(): Promise<void> {
        const failures: unknown[] = [];
        await this.#state
            .prepareRetirement()
            .catch((error) => failures.push(error));
        await this.#generation.drain();
        await this.#state.retire().catch((error) => failures.push(error));
        if (failures.length === 0) {
            this.#generation.completeRetirement();
            return;
        }
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(
            failures,
            `Instance ${this.config.name} retirement was incomplete.`,
        );
    }

    async #close(): Promise<void> {
        const failures: unknown[] = [];
        await this.retire().catch((error) => failures.push(error));
        let resourcesClosed = false;
        await this.#state
            .close()
            .then(() => {
                resourcesClosed = true;
            })
            .catch((error) => failures.push(error));
        if (resourcesClosed) this.#generation.completeClose();
        if (failures.length === 0) return;
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(
            failures,
            `Instance ${this.config.name} failed to close.`,
        );
    }
}

function createWorkerInstance(
    config: WorkerInstanceConfig,
    events: InstanceEventPort,
): { protocolClient: WorkerProtocolClient; worker: WorkerInstance } {
    const resolved = resolveWorkerInstanceConfig(config);
    const transportConnection = resolved.transportConnection;
    const workerHost = `${resolved.name}-worker`;
    const endpoint = TransportFactory.createEndpoint(
        transportConnection,
        resolved.name,
        workerHost,
    );
    const protocolClient = new WorkerProtocolClient(endpoint, workerHost);
    const worker = new WorkerRuntime({
        commandClient:
            resolved.runtime === undefined
                ? undefined
                : new WorkerCommandClient(
                      resolved.runtime,
                      resolved.name,
                      resolved.env,
                  ),
        config: resolved,
        events,
        endpoint,
        protocolClient,
        stateMachine: new InstanceStateMachine(resolved.name),
        transportConnection,
    });
    return { protocolClient, worker };
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
