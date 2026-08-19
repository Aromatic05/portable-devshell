import { createError, errorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import { McpContextRegistry } from "../../context/McpContextRegistry.js";
import { readMcpWorkspace } from "../McpEndpointInput.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "../McpEndpointPort.js";
import {
    auditMcpEndpointTool,
    mcpEndpointToolNotExposed,
    requireMcpEndpointEnvironment
} from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerEnvironment {
    readonly #contextRegistry: McpContextRegistry;
    readonly #instanceName: string;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: {
        contextRegistry: McpContextRegistry;
        instanceName: string;
        worker: McpEndpointWorkerPort;
    }) {
        this.#contextRegistry = options.contextRegistry;
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
    }

    async call(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        exposed: boolean,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        if (!exposed) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }
        const workspace = readMcpWorkspace(input, toolName);
        const { alerts, environment, prepared } = await this.#prepareEnvironment(workspace);
        const record = await this.#contextRegistry.create({
            instance: this.#instanceName,
            principal: requestContext.principal,
            temporaryDirectory: prepared.temporaryDirectory,
            workspace: prepared.workspace
        });
        try {
            await this.#worker.appendMcpToolCalled(toolName, {
                ctxId: record.ctxId,
                requestId: requestContext.requestId
            });
            const context: ToolCallContext = {
                ctxId: record.ctxId,
                requestId: requestContext.requestId,
                source: "mcp",
                workspace: record.workspace,
            };
            return await auditMcpEndpointTool({
                context,
                input: {},
                localInstance: this.#instanceName,
                operation: async () => ({
                    ctxId: record.ctxId,
                    expiresAt: record.expiresAt,
                    comment: [
                        `Read ${prepared.projectMemoryAgentFile} before working.`,
                        `Use ${prepared.projectMemoryDirectory} for durable project memory; keep it useful for future sessions.`,
                        `Use ${prepared.temporaryDirectory} for all temporary files.`,
                        ...alerts.map((advice) => advice.text)
                    ],
                    instance: this.#instanceName,
                    platform: {
                        arch: environment.platform.arch,
                        ...(environment.platform.distribution === undefined ? {} : { distribution: environment.platform.distribution }),
                        os: environment.platform.os,
                        ...(environment.platform.packageManager === undefined ? {} : { packageManager: environment.platform.packageManager }),
                        ...(environment.platform.shell === undefined ? {} : { shell: environment.platform.shell.kind })
                    },
                    skillsDirectory: environment.skillsDirectory,
                    workspace: record.workspace,
                    projectMemoryAgentFile: prepared.projectMemoryAgentFile,
                    projectMemoryDirectory: prepared.projectMemoryDirectory,
                    temporaryDirectory: prepared.temporaryDirectory
                }),
                signal,
                targetInstance: this.#instanceName,
                toolName,
                worker: this.#worker,
            });
        } catch (error) {
            await this.#rollbackUndisclosedContext(
                record.ctxId,
                record.workspace
            ).catch(() => undefined);
            throw error;
        }
    }

    async #prepareEnvironment(workspace: string) {
        const environment = requireMcpEndpointEnvironment(this.#worker, this.#instanceName);
        const prepareWorkspace = this.#worker.prepareWorkspace;
        if (prepareWorkspace === undefined) {
            throw workspacePreparationUnavailable(this.#instanceName);
        }
        const prepared = await prepareWorkspace.call(this.#worker, workspace);
        const alerts = (await this.#worker.readAlerts(prepared.workspace)).advice;
        return { alerts, environment, prepared };
    }

    async #rollbackUndisclosedContext(
        ctxId: string,
        workspace: string
    ): Promise<void> {
        await this.#contextRegistry.discard(ctxId);
        const now = Date.now();
        const hasOtherActiveContext = (await this.#contextRegistry.list()).some((context) =>
            context.status === "active" &&
            Date.parse(context.expiresAt) > now &&
            context.environments.some((environment) =>
                environment.instance === this.#instanceName && environment.workspace === workspace
            )
        );
        if (hasOtherActiveContext) return;
        await this.#worker.releaseAlerts?.(workspace);
    }
}

function workspacePreparationUnavailable(instance: string) {
    return createError({
        code: errorCodes.coreWorkerHandshakeFailed,
        details: { instance },
        message: `Workspace preparation is unavailable for ${instance}.`,
        retryable: true
    });
}
