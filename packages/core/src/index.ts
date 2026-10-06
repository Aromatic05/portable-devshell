import { homedir } from "node:os";

import {
    asInstanceName,
    createRemoteError,
    runtimeErrorCodes,
    STREAM_GAP_CODE,
    type ApprovalRequest,
    type ControlInstanceConfig,
    type InstanceEventRecord,
    type JsonValue,
    type ToolDefinition,
} from "@portable-devshell/shared";

import type { InstanceRuntime, InstanceRuntimeRegistry } from "./Api.js";
import { createApprovalRuntime } from "./approval/index.js";
import { createAuditRuntime } from "./audit/index.js";
import { createContextRuntime } from "./context/index.js";
import { createInstance } from "./instance/index.js";
import { Instance } from "./instance/Instance.js";
import { InstancePaths } from "./instance/Paths.js";
import { createTaskRuntime } from "./task/index.js";
import {
    createTerminalRuntime,
    createTerminalSessionRuntime,
} from "./terminal/index.js";
import {
    createToolCallExecutionRuntime,
    createToolCallProvenanceRuntime,
    createToolCallRuntime,
} from "./toolcall/index.js";
import type {
    ToolCallDispatchRequest,
    ToolCallTarget,
} from "./toolcall/Api.js";

export {
    createContextRuntime,
    createTerminalSessionRuntime,
    createToolCallProvenanceRuntime,
    createToolCallRuntime,
};

export { createApprovalRouteModule } from "./approval/Route.js";
export { registerApprovalToolCallReview } from "./approval/execution/ToolCallReview.js";
export type { ApprovalApi } from "./approval/Api.js";
export { createContextRouteModule } from "./context/Route.js";
export { installContextTools } from "./context/tool/Runtime.js";
export type { ContextRuntime } from "./context/Api.js";
export { Instance } from "./instance/Instance.js";
export { InstanceRegistry } from "./instance/Registry.js";
export { InstancePaths } from "./instance/Paths.js";
export {
    createConnectionRouteModule,
    createInstanceHost,
} from "./instance/Route.js";
export { ConnectionModule } from "./instance/transport/endpoint/channel/reverse/Module.js";
export { ReverseCredentials } from "./instance/transport/endpoint/channel/reverse/credential/Credentials.js";
export {
    assertInstanceDeletable,
    InstanceRetirementNotification,
    retireInstanceForDelete,
} from "./instance/runtime/provision/Retirement.js";
export {
    discoverSshConfigHosts,
    normalizeInstanceCreateDraft,
    resolveInstanceCreateSchema,
    summarizeInstanceCreate,
} from "./instance/runtime/provision/Config.js";
export { ProcessSubscriptionManager } from "./instance/runtime/supervision/Subscription.js";
export { WORKER_PROTOCOL_RANGE } from "./instance/transport/packet/Client.js";
export type { InstanceRuntime, InstanceRuntimeRegistry } from "./Api.js";
export type { WorkerInstance } from "./instance/Api.js";
export { createGoalTaskRouteModule } from "./task/goal/Route.js";
export { createTodoTaskRouteModule } from "./task/todo/Route.js";
export { installTodoTools } from "./task/todo/tool/Runtime.js";
export { installWaitToolCallRewrite } from "./task/wait/Runtime.js";
export type { TaskApi } from "./task/Api.js";
export { createTerminalRouteModule } from "./terminal/Route.js";
export type { TerminalSessionApi } from "./terminal/Api.js";
export { presentToolCallResult } from "./toolcall/execution/Presentation.js";
export { createToolIngressHost } from "./toolcall/execution/transport/Route.js";
export { createToolRouteModule } from "./toolcall/execution/transport/ToolRoute.js";
export type {
    ToolCallApi,
    ToolCallExecutor,
    ToolCallHookContributor,
    ToolCallHookValue,
    ToolCallHooks,
    ToolCallIngressPort,
    ToolCallProvenanceApi,
    ToolCallRegistration,
    ToolCallReviewHook,
    ToolCallRuntime,
    ToolNameHandle,
} from "./toolcall/Api.js";

type ToolCallRegistry = {
    register(scope: string, definitions: readonly ToolDefinition[]): {
        replace(definitions: readonly ToolDefinition[]): void;
        dispose(): void;
    };
};

interface InstanceRuntimeOptions {
    config: ControlInstanceConfig;
    homeDirectory: string;
    toolCalls: ToolCallRegistry;
}

interface InstanceRuntimeRegistryOptions {
    homeDirectory?: string;
    toolCalls: ToolCallRegistry;
}

type ToolCallDefinitionRegistration = ReturnType<ToolCallRegistry["register"]>;

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
