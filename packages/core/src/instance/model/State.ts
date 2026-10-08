import {
    createRemoteError,
    runtimeErrorCodes,
    type ApprovalRequest,
    type ControlInstanceConfig,
    type Endpoint,
    type InstanceName,
    type JsonValue,
    type ToolDefinition,
    createToolCallRuntime,
    type ToolCallRuntime,
    type WorkerWorkspacePrepareResult,
} from "@portable-devshell/shared";

import type { ApprovalRuntime } from "../../approval/Api.js";
import { createApprovalRuntime } from "../../approval/index.js";
import { registerApprovalToolCallReview } from "../../approval/execution/ToolCallReview.js";
import type { AuditRuntime } from "../../audit/Api.js";
import type { TaskRuntime } from "../../task/Api.js";
import { createTaskRuntime } from "../../task/index.js";
import { installTodoTools } from "../../task/todo/tool/Runtime.js";
import { todoToolDefinitions } from "../../task/todo/tool/Definition.js";
import { mcpAppActionDefinition, mcpAppReentryDefinition } from "../mcpapp/Definition.js";
import { installMcpAppAction } from "../mcpapp/index.js";
import { installMcpAppReentry } from "../mcpapp/Reentry.js";
import { installWaitToolCallRewrite } from "../../task/wait/Runtime.js";
import type { TerminalRuntime } from "../../terminal/Api.js";
import { createTerminalRuntime } from "../../terminal/index.js";
import type {
    ToolCallDispatchRequest,
    ToolCallExecutionRuntime,
    ToolCallTarget,
} from "../../toolcall/Api.js";
import { createToolCallExecutionRuntime } from "../../toolcall/index.js";
import type { WorkerTerminalPort } from "../../terminal/Api.js";
import type { InstancePaths } from "./Paths.js";
import {
    InstanceToolCatalog,
    type InstanceToolDefinitionRegistration,
} from "./Tools.js";

interface InstanceStateDependencies {
    acquireLease(): { release(): void };
    appendEvent(type: string, data?: JsonValue): Promise<void>;
    audit: AuditRuntime;
    assertReady(): void;
    config: ControlInstanceConfig;
    endpoint: Endpoint;
    instanceName: InstanceName;
    paths: InstancePaths;
    prepareWorkspace(workspace: string): Promise<WorkerWorkspacePrepareResult>;
    readTools(): Promise<readonly ToolDefinition[]>;
    releaseWorkspace(workspace: string): Promise<void>;
    terminal: WorkerTerminalPort;
}

export class InstanceState {
    readonly approval: ApprovalRuntime;
    readonly audit: AuditRuntime;
    readonly task: TaskRuntime;
    readonly terminal: TerminalRuntime;
    readonly tools: ToolCallExecutionRuntime;
    readonly toolCalls: ToolCallRuntime;
    readonly #acquireLease: InstanceStateDependencies["acquireLease"];
    readonly #instanceName: InstanceName;
    readonly #toolDefinitions = new InstanceToolCatalog();
    readonly #workerToolRegistration: InstanceToolDefinitionRegistration;
    readonly #domainToolRegistration: InstanceToolDefinitionRegistration;
    readonly #toolCallUnregister: readonly (() => void)[];
    #closePromise?: Promise<void>;
    #retirePromise?: Promise<void>;
    #retiring = false;

    constructor(dependencies: InstanceStateDependencies) {
        const { audit, config, instanceName, paths } = dependencies;
        this.#acquireLease = dependencies.acquireLease;
        this.#instanceName = instanceName;
        this.audit = audit;
        const appendEvent = dependencies.appendEvent;
        this.approval = createApprovalRuntime({
            appendEvent,
            instanceName,
            policy: config.approvalPolicy,
            stateStore: audit.api.state<ApprovalRequest>("approvals"),
        });
        this.tools = createToolCallExecutionRuntime({
            appendEvent,
            assertReady: dependencies.assertReady,
            audit: audit.api,
            endpoint: dependencies.endpoint,
            instanceName,
            prepareWorkspace: dependencies.prepareWorkspace,
            readTools: dependencies.readTools,
            releaseWorkspace: dependencies.releaseWorkspace,
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
        this.terminal = createTerminalRuntime(dependencies.terminal);
        this.#workerToolRegistration = this.#toolDefinitions.register([]);
        this.#domainToolRegistration = this.#toolDefinitions.register(
            [...todoToolDefinitions(), mcpAppActionDefinition(), mcpAppReentryDefinition()],
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
            installMcpAppAction(this.toolCalls.hooks, {
                approval: this.approval.api,
                task: this.task.api,
            }),
            installMcpAppReentry(this.toolCalls.hooks, this.task.api.goal),
            installWaitToolCallRewrite(
                this.toolCalls.hooks,
                this.task.api.wait,
            ),
        ];
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
                const lease = this.#acquireLease();
                try {
                    return await this.callTool(request);
                } finally {
                    lease.release();
                }
            },
        };
    }

    async refreshTools(): Promise<void> {
        if (this.#retiring)
            throw new Error(
                `Instance ${this.#instanceName} domains are retiring.`,
            );
        const definitions = await this.tools.refreshTools();
        if (this.#retiring) return;
        this.#workerToolRegistration.replace(definitions);
        this.task.resume();
    }

    async prepareRetirement(): Promise<void> {
        this.#retiring = true;
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

    async handleReadyChanged(ready: boolean): Promise<void> {
        if (this.#retiring) return;
        if (ready) await this.refreshTools();
        else this.#workerToolRegistration.replace([]);
    }

    async #retire(): Promise<void> {
        this.#retiring = true;
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
        await close(() => this.#workerToolRegistration.dispose());
        await close(() => this.#domainToolRegistration.dispose());
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${this.#instanceName} domains failed to close.`,
            );
    }

    async #close(): Promise<void> {
        const failures: unknown[] = [];
        await this.retire().catch((error) => {
            failures.push(error);
        });
        await this.audit.close().catch((error) => {
            failures.push(error);
        });
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${this.#instanceName} failed to close.`,
            );
    }
}
