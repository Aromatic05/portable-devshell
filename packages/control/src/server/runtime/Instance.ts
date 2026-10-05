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
} from "@portable-devshell/shared";
import { createInstance, InstancePaths, type Instance } from "@portable-devshell/core/instance";
import { createApprovalRuntime, type ApprovalRuntime } from "@portable-devshell/core/approval";
import { createTaskRuntime, type TaskRuntime } from "@portable-devshell/core/task";
import { createTerminalRuntime, type TerminalRuntime } from "@portable-devshell/core/terminal";
import { createAuditRuntime, type AuditRuntime } from "@portable-devshell/core/audit";
import { createToolCallExecutionRuntime, type ToolCallDispatchRequest, type ToolCallExecutionRuntime, type ToolCallTarget } from "@portable-devshell/core/toolcall";
import { mcpTools, type McpToolRegistration } from "@portable-devshell/mcp/tool";

export class InstanceRuntime {
    readonly instance: Instance;
    readonly audit: AuditRuntime;
    readonly approval: ApprovalRuntime;
    readonly task: TaskRuntime;
    readonly terminal: TerminalRuntime;
    readonly tools: ToolCallExecutionRuntime;
    readonly #toolRegistration: McpToolRegistration;
    readonly #flushEvents: () => Promise<void>;
    #closePromise?: Promise<void>;
    #retirePromise?: Promise<void>;
    readonly #toolSessions = new Map<string, string>();
    #retired = false;

    constructor(config: ControlInstanceConfig, homeDirectory: string) {
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
        this.#toolRegistration = mcpTools.register(config.name, []);
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

export class InstanceRuntimeRegistry {
    readonly #homeDirectory: string;
    readonly #runtimes = new Map<Instance, InstanceRuntime>();

    constructor(homeDirectory = homedir()) {
        this.#homeDirectory = homeDirectory;
    }

    create(config: ControlInstanceConfig): Instance {
        const runtime = new InstanceRuntime(config, this.#homeDirectory);
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
