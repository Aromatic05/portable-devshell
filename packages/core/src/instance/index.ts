import { homedir } from "node:os";

import type {
    InstanceEventPort,
    InstanceRuntime,
    InstanceRuntimeOptions,
    InstanceRuntimeRegistry,
    InstanceRuntimeRegistryOptions,
} from "./Api.js";
import {
    asInstanceName,
    createRemoteError,
    runtimeErrorCodes,
    STREAM_GAP_CODE,
    type ApprovalRequest,
    type ControlInstanceConfig,
    type InstanceEventRecord,
    type JsonValue,
} from "@portable-devshell/shared";

import { createApprovalRuntime } from "../approval/index.js";
import { createAuditRuntime } from "../audit/index.js";
import { createTaskRuntime } from "../task/index.js";
import { createTerminalRuntime } from "../terminal/index.js";
import { createToolCallExecutionRuntime } from "../toolcall/index.js";
import type {
    ToolCallDispatchRequest,
    ToolCallTarget,
} from "../toolcall/Api.js";

import { Instance } from "./Instance.js";
import { InstancePaths } from "./Paths.js";
import { resolveWorkerHomeDirectory } from "./runtime/provision/Home.js";
import {
    WorkerRuntimeFactory,
    type WorkerRuntimeFactoryOptions,
} from "./runtime/provision/Factory.js";
import { ReverseProvision } from "./runtime/provision/install/provider/Reverse.js";
import { WorkerInstance } from "./runtime/index.js";

import { WorkerCommandClient } from "./runtime/execution/Command.js";
import { WorkerProtocolClient } from "./transport/packet/Client.js";
import { InstanceStateMachine } from "./runtime/supervision/State.js";
import { TransportConnection } from "./transport/endpoint/Connection.js";
import { TransportFactory } from "./transport/endpoint/Factory.js";
import {
    resolveWorkerInstanceConfig,
    type WorkerInstanceConfig,
} from "./runtime/provision/Config.js";


export function createInstance(
    config: ControlInstanceConfig,
    dependencies: { events: InstanceEventPort },
): Instance {
    const homeDirectory = resolveWorkerHomeDirectory();
    const reverse =
        config.provider === "reverse" ? new ReverseProvision() : undefined;
    const worker = createWorkerInstance(
        toWorkerConfig(config, reverse, homeDirectory),
        dependencies.events,
    );

    return new Instance({
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
        worker,
    });
}

function createWorkerInstance(
    config: WorkerInstanceConfig,
    events: InstanceEventPort,
): WorkerInstance {
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
        events,
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

type ToolCallDefinitionRegistration = ReturnType<InstanceRuntimeOptions["toolCalls"]["register"]>;
type ToolCallRegistry = InstanceRuntimeRegistryOptions["toolCalls"];

class InstanceRuntimeState implements InstanceRuntime {
    readonly instance: Instance;
    readonly audit: InstanceRuntime["audit"];
    readonly approval: InstanceRuntime["approval"];
    readonly task: InstanceRuntime["task"];
    readonly terminal: InstanceRuntime["terminal"];
    readonly tools: InstanceRuntime["tools"];
    readonly #toolRegistration: ToolCallDefinitionRegistration;
    readonly #flushEvents: () => Promise<void>;
    #closePromise?: Promise<void>;
    #retirePromise?: Promise<void>;
    readonly #toolSessions = new Map<string, string>();
    #retired = false;

    constructor(options: InstanceRuntimeOptions) {
        const { config, homeDirectory, toolCalls } = options;
        const instanceName = asInstanceName(config.name);
        const paths = new InstancePaths(instanceName, homeDirectory);
        this.audit = createAuditRuntime({
            instanceName,
            filePath: paths.auditDatabaseFile,
            eventBufferSize: config.logs?.eventBufferSize ?? 1024,
        });
        let appendTail = Promise.resolve();
        this.#flushEvents = () => appendTail;
        const readEvents = (fromSeq = 1) => {
            const lastSeq = this.audit.api.events.readHighWater();
            const records = this.audit.api.events.readFrom(fromSeq);
            const nextSeq = this.audit.api.events.readFrom(1, 1)[0]?.seq ?? lastSeq + 1;
            return fromSeq < nextSeq
                ? { code: STREAM_GAP_CODE as typeof STREAM_GAP_CODE, fromSeq, kind: "gap" as const, lastSeq, nextSeq }
                : { events: records, kind: "events" as const, lastSeq };
        };
        const events = {
            cursor: () => this.audit.api.events.readHighWater(),
            append: (input: { at: string; data?: JsonValue; type: string }) => {
                const operation = appendTail.then(async () => {
                    const record: InstanceEventRecord = {
                        ...input,
                        instanceName,
                        seq: this.audit.api.events.readHighWater() + 1,
                    };
                    await this.audit.api.events.append(record);
                    if (record.type === "instance.readyChanged") {
                        if (!this.#retired) {
                            if (this.instance.worker.snapshot().ready) await this.refreshTools();
                            else this.#toolRegistration.replace([]);
                        }
                    }
                    return record;
                });
                appendTail = operation.then(() => undefined, () => undefined);
                return operation;
            },
            readFrom: readEvents,
            subscribe: readEvents,
        };
        this.instance = createInstance(config, { events });
        const appendEvent = async (type: string, data?: JsonValue) =>
            await this.instance.worker.appendControlEvent(type, data);
        this.approval = createApprovalRuntime({
            appendEvent,
            instanceName,
            policy: config.approvalPolicy,
            stateStore: this.audit.api.state<ApprovalRequest>("approvals"),
        });
        this.tools = createToolCallExecutionRuntime({
            appendEvent,
            assertReady: () => {
                if (this.instance.worker.snapshot().ready) return;
                throw createRemoteError({
                    code: runtimeErrorCodes.instanceNotReady,
                    details: { instance: config.name },
                    message: `Instance ${config.name} is not ready.`,
                    retryable: false,
                });
            },
            audit: this.audit.api,
            endpoint: this.instance.worker.endpoint,
            instanceName,
            readTools: () => this.instance.worker.readWorkerTools(),
        });
        this.task = createTaskRuntime({
            appendEvent: async (type, data) => { await appendEvent(type, data); },
            instanceName,
            invokeTool: (toolName, input, context, signal) =>
                this.tools.invokeInternal(toolName, input, context, signal),
            paths,
        });
        this.terminal = createTerminalRuntime(this.instance.worker);
        this.#toolRegistration = toolCalls.register(config.name, []);
    }

    async refreshTools(): Promise<void> {
        if (this.#retired) throw new Error(`Instance ${this.instance.name} runtime is retired.`);
        const definitions = await this.tools.refreshTools();
        if (this.#retired) return;
        this.#toolRegistration.replace(definitions);
        this.task.resume();
    }

    async openToolSession(workspace: string, connectionId: string) {
        await this.releaseToolSession(connectionId);
        const prepared = await this.instance.worker.prepareWorkspace(workspace);
        this.#toolSessions.set(connectionId, prepared.workspace);
        await this.refreshTools();
        return prepared;
    }

    async releaseToolSession(connectionId: string): Promise<void> {
        const workspace = this.#toolSessions.get(connectionId);
        if (workspace === undefined) return;
        this.#toolSessions.delete(connectionId);
        if ([...this.#toolSessions.values()].includes(workspace)) return;
        await this.instance.worker.releaseAlerts(workspace);
    }

    target(): ToolCallTarget {
        return {
            dispatch: async (request) => {
                const lease = this.instance.acquireLease();
                try {
                    return await this.callTool(request);
                } finally {
                    lease.release();
                }
            },
        };
    }

    async callTool(request: ToolCallDispatchRequest): Promise<JsonValue> {
        return await this.tools.target().dispatch(request);
    }

    close(): Promise<void> {
        this.#closePromise ??= this.#close().catch((error) => {
            this.#closePromise = undefined;
            throw error;
        });
        return this.#closePromise;
    }

    retire(): Promise<void> {
        this.#retirePromise ??= this.#retire().catch((error) => {
            this.#retirePromise = undefined;
            throw error;
        });
        return this.#retirePromise;
    }

    async #retire(): Promise<void> {
        this.#retired = true;
        const failures: unknown[] = [];
        const close = async (operation: () => unknown | Promise<unknown>) => {
            try { await operation(); } catch (error) { failures.push(error); }
        };
        await close(() => this.approval.close());
        await close(() => this.task.close());
        await close(() => this.tools.close());
        for (const connectionId of this.#toolSessions.keys())
            await close(() => this.releaseToolSession(connectionId));
        await close(() => this.#toolRegistration.dispose());
        if (failures.length > 0)
            throw new AggregateError(failures, `Instance ${this.instance.name} domains failed to close.`);
    }

    async #close(): Promise<void> {
        const failures: unknown[] = [];
        await this.instance.retire(() => this.prepareRetirement()).catch((error) => failures.push(error));
        await this.retire().catch((error) => failures.push(error));
        await this.instance.close().catch((error) => failures.push(error));
        await this.#flushEvents().catch((error) => failures.push(error));
        await this.audit.close().catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(failures, `Instance ${this.instance.name} failed to close.`);
    }

    async prepareRetirement(): Promise<void> {
        await this.approval.retire("Instance generation retired.");
    }
}

class InstanceRuntimeRegistryState implements InstanceRuntimeRegistry {
    readonly #homeDirectory: string;
    readonly #runtimes = new Map<Instance, InstanceRuntime>();
    readonly #toolCalls: ToolCallRegistry;

    constructor(options: InstanceRuntimeRegistryOptions) {
        this.#homeDirectory = options.homeDirectory ?? homedir();
        this.#toolCalls = options.toolCalls;
    }

    create(config: ControlInstanceConfig): Instance {
        const runtime = new InstanceRuntimeState({
            config,
            homeDirectory: this.#homeDirectory,
            toolCalls: this.#toolCalls,
        });
        this.#runtimes.set(runtime.instance, runtime);
        return runtime.instance;
    }

    get(instance: Instance): InstanceRuntime {
        const runtime = this.#runtimes.get(instance);
        if (runtime === undefined) throw new Error(`Instance ${instance.name} runtime is unavailable.`);
        return runtime;
    }

    async retire(instance: Instance): Promise<void> {
        await this.get(instance).prepareRetirement();
    }

    async finalize(instance: Instance): Promise<void> {
        const runtime = this.get(instance);
        await runtime.close();
        this.#runtimes.delete(instance);
    }

    async close(): Promise<void> {
        const failures: unknown[] = [];
        for (const instance of this.#runtimes.keys()) {
            try { await this.finalize(instance); } catch (error) { failures.push(error); }
        }
        if (failures.length > 0)
            throw new AggregateError(failures, "Instance domains failed to close.");
    }
}

export function createInstanceRuntimeRegistry(
    options: InstanceRuntimeRegistryOptions,
): InstanceRuntimeRegistry {
    return new InstanceRuntimeRegistryState(options);
}
