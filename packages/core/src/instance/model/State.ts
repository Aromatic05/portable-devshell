import {
    createRemoteError,
    runtimeErrorCodes,
    STREAM_GAP_CODE,
    type ApprovalRequest,
    type ControlInstanceConfig,
    type InstanceEventRecord,
    type InstanceName,
    type JsonValue,
    createToolCallRuntime,
    type ToolCallRuntime,
} from "@portable-devshell/shared";

import type { ApprovalRuntime } from "../../approval/Api.js";
import { createApprovalRuntime } from "../../approval/index.js";
import { registerApprovalToolCallReview } from "../../approval/execution/ToolCallReview.js";
import type { AuditRuntime } from "../../audit/Api.js";
import type { TaskRuntime } from "../../task/Api.js";
import { createTaskRuntime } from "../../task/index.js";
import { installTodoTools } from "../../task/todo/tool/Runtime.js";
import { todoToolDefinitions } from "../../task/todo/tool/Definition.js";
import { installWaitToolCallRewrite } from "../../task/wait/Runtime.js";
import type { TerminalRuntime } from "../../terminal/Api.js";
import { createTerminalRuntime } from "../../terminal/index.js";
import type {
    ToolCallDispatchRequest,
    ToolCallExecutionRuntime,
    ToolCallTarget,
} from "../../toolcall/Api.js";
import { createToolCallExecutionRuntime } from "../../toolcall/index.js";
import type {
    InstanceEventPort,
    WorkerWorkspacePrepareResult,
} from "../Api.js";
import type { WorkerInstance } from "../runtime/Api.js";
import { ProcessSubscriptionManager } from "@portable-devshell/shared";
import type { WorkerProtocolClient } from "../transport/packet/Client.js";
import type { Instance } from "./Instance.js";
import type { InstancePaths } from "./Paths.js";
import {
    InstanceToolCatalog,
    type InstanceToolDefinitionRegistration,
} from "./Tools.js";

export interface InstanceEventLog {
    readonly port: InstanceEventPort;
    flush(): Promise<void>;
}

export function createInstanceEventLog(
    audit: AuditRuntime,
    instanceName: InstanceName,
    onReadyChanged: () => Promise<void>,
): InstanceEventLog {
    let appendTail = Promise.resolve();
    const readEvents = (fromSeq = 1) => {
        const lastSeq = audit.api.events.readHighWater();
        const records = audit.api.events.readFrom(fromSeq);
        const nextSeq = audit.api.events.readFrom(1, 1)[0]?.seq ?? lastSeq + 1;
        return fromSeq < nextSeq
            ? {
                  code: STREAM_GAP_CODE as typeof STREAM_GAP_CODE,
                  fromSeq,
                  kind: "gap" as const,
                  lastSeq,
                  nextSeq,
              }
            : { events: records, kind: "events" as const, lastSeq };
    };
    return {
        flush: () => appendTail,
        port: {
            append: (input) => {
                const operation = appendTail.then(async () => {
                    const record: InstanceEventRecord = {
                        ...input,
                        instanceName,
                        seq: audit.api.events.readHighWater() + 1,
                    };
                    await audit.api.events.append(record);
                    if (record.type === "instance.readyChanged")
                        await onReadyChanged();
                    return record;
                });
                appendTail = operation.then(
                    () => undefined,
                    () => undefined,
                );
                return operation;
            },
            cursor: () => audit.api.events.readHighWater(),
            readFrom: readEvents,
        },
    };
}

interface InstanceStateDependencies {
    audit: AuditRuntime;
    config: ControlInstanceConfig;
    eventLog: InstanceEventLog;
    instanceName: InstanceName;
    paths: InstancePaths;
    protocolClient: WorkerProtocolClient;
    resolveInstance: () => Instance;
    worker: WorkerInstance;
}

export class InstanceState {
    readonly approval: ApprovalRuntime;
    readonly audit: AuditRuntime;
    readonly task: TaskRuntime;
    readonly terminal: TerminalRuntime;
    readonly tools: ToolCallExecutionRuntime;
    readonly toolCalls: ToolCallRuntime;
    readonly subscriptions = new ProcessSubscriptionManager();
    readonly #eventLog: InstanceEventLog;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #resolveInstance: () => Instance;
    readonly #toolDefinitions = new InstanceToolCatalog();
    readonly #workerToolRegistration: InstanceToolDefinitionRegistration;
    readonly #domainToolRegistration: InstanceToolDefinitionRegistration;
    readonly #toolCallUnregister: readonly (() => void)[];
    readonly #toolSessions = new Map<string, string>();
    readonly #worker: WorkerInstance;
    #closePromise?: Promise<void>;
    #retirePromise?: Promise<void>;
    #retired = false;

    constructor(dependencies: InstanceStateDependencies) {
        const { audit, config, instanceName, paths, protocolClient, worker } =
            dependencies;
        this.audit = audit;
        this.#eventLog = dependencies.eventLog;
        this.#protocolClient = protocolClient;
        this.#resolveInstance = dependencies.resolveInstance;
        this.#worker = worker;
        const appendEvent = async (type: string, data?: JsonValue) => {
            await worker.supervision.state.appendEvent(type, data);
        };
        this.approval = createApprovalRuntime({
            appendEvent,
            instanceName,
            policy: config.approvalPolicy,
            stateStore: audit.api.state<ApprovalRequest>("approvals"),
        });
        this.tools = createToolCallExecutionRuntime({
            appendEvent,
            assertReady: () => {
                if (worker.supervision.snapshot().ready) return;
                throw createRemoteError({
                    code: runtimeErrorCodes.instanceNotReady,
                    details: { instance: config.name },
                    message: `Instance ${config.name} is not ready.`,
                    retryable: false,
                });
            },
            audit: audit.api,
            endpoint: worker.supervision.endpoint,
            instanceName,
            readTools: async () => (await protocolClient.listTools()).tools,
        });
        this.task = createTaskRuntime({
            appendEvent: async (type, data) => {
                await appendEvent(type, data);
            },
            instanceName,
            invokeTool: (toolName, input, context, signal) =>
                this.tools.invokeInternal(toolName, input, context, signal),
            paths,
        });
        this.terminal = createTerminalRuntime(worker.execution.terminal);
        this.#workerToolRegistration = this.#toolDefinitions.register([]);
        this.#domainToolRegistration = this.#toolDefinitions.register(
            todoToolDefinitions(),
        );
        this.toolCalls = createToolCallRuntime({
            resolveTarget: (target) => {
                if (target !== instanceName) {
                    throw createRemoteError({
                        code: runtimeErrorCodes.instanceConflict,
                        details: { instance: target },
                        message: `Tool call target ${target} does not match instance ${instanceName}.`,
                        retryable: false,
                    });
                }
                return this.target();
            },
        });
        this.#toolCallUnregister = [
            registerApprovalToolCallReview(
                this.toolCalls.hooks,
                this.approval.api,
            ),
            installTodoTools(this.toolCalls.hooks, this.task.api),
            installWaitToolCallRewrite(
                this.toolCalls.hooks,
                this.task.api.wait,
            ),
        ];
    }

    get instance(): Instance {
        return this.#resolveInstance();
    }

    get toolDefinitions(): InstanceToolCatalog {
        return this.#toolDefinitions;
    }

    async callTool(request: ToolCallDispatchRequest): Promise<JsonValue> {
        return await this.tools.target().dispatch(request);
    }

    target(): ToolCallTarget {
        return {
            dispatch: async (request) => {
                const lease = this.instance.lifecycle.acquireLease();
                try {
                    return await this.callTool(request);
                } finally {
                    lease.release();
                }
            },
        };
    }

    async refreshTools(): Promise<void> {
        if (this.#retired)
            throw new Error(
                `Instance ${this.instance.config.name} state is retired.`,
            );
        const definitions = await this.tools.refreshTools();
        if (this.#retired) return;
        this.#workerToolRegistration.replace(definitions);
        this.task.resume();
    }

    async openToolSession(
        workspace: string,
        connectionId: string,
    ): Promise<WorkerWorkspacePrepareResult> {
        await this.releaseToolSession(connectionId);
        const prepared =
            await this.#protocolClient.prepareWorkspace(workspace);
        this.#toolSessions.set(connectionId, prepared.workspace);
        await this.refreshTools();
        return prepared;
    }

    async releaseToolSession(connectionId: string): Promise<void> {
        const workspace = this.#toolSessions.get(connectionId);
        if (workspace === undefined) return;
        this.#toolSessions.delete(connectionId);
        if ([...this.#toolSessions.values()].includes(workspace)) return;
        await this.#protocolClient.releaseAlerts(workspace);
    }

    async prepareRetirement(): Promise<void> {
        await this.approval.retire("Instance generation retired.");
    }

    retire(): Promise<void> {
        this.#retirePromise ??= this.#retire().catch((error) => {
            this.#retirePromise = undefined;
            throw error;
        });
        return this.#retirePromise;
    }

    close(): Promise<void> {
        this.#closePromise ??= this.#close().catch((error) => {
            this.#closePromise = undefined;
            throw error;
        });
        return this.#closePromise;
    }

    async handleReadyChanged(): Promise<void> {
        if (this.#retired) return;
        if (this.#worker.supervision.snapshot().ready)
            await this.refreshTools();
        else this.#workerToolRegistration.replace([]);
    }

    async #retire(): Promise<void> {
        this.#retired = true;
        const failures: unknown[] = [];
        const close = async (operation: () => unknown | Promise<unknown>) => {
            try {
                await operation();
            } catch (error) {
                failures.push(error);
            }
        };
        await close(() => this.approval.close());
        await close(() => this.task.close());
        for (const unregister of [...this.#toolCallUnregister].reverse())
            await close(() => unregister());
        await close(() => this.toolCalls.close());
        await close(() => this.tools.close());
        await close(() => this.terminal.sessions.close());
        await close(() => this.subscriptions.close());
        for (const connectionId of this.#toolSessions.keys())
            await close(async () => await this.releaseToolSession(connectionId));
        await close(() => this.#workerToolRegistration.dispose());
        await close(() => this.#domainToolRegistration.dispose());
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${this.instance.config.name} domains failed to close.`,
            );
    }

    async #close(): Promise<void> {
        const failures: unknown[] = [];
        await this.instance.lifecycle
            .retire(async () => await this.prepareRetirement())
            .catch((error) => {
                failures.push(error);
            });
        await this.retire().catch((error) => {
            failures.push(error);
        });
        await this.#worker.supervision.close().catch((error) => {
            failures.push(error);
        });
        await this.#eventLog.flush().catch((error) => {
            failures.push(error);
        });
        await this.audit.close().catch((error) => {
            failures.push(error);
        });
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${this.instance.config.name} failed to close.`,
            );
    }
}
