import { createError, errorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import { McpContextRegistry } from "../../context/McpContextRegistry.js";
import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import { readMcpRoutedInput, readMcpWorkspace } from "../McpEndpointInput.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "../McpEndpointPort.js";
import {
    auditMcpEndpointTool,
    mcpEndpointToolNotExposed,
    requireMcpEndpointEnvironment,
    requireMcpEndpointGateway,
    waitForMcpGatewayReady
} from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerEnvironment {
    readonly #contextRegistry: McpContextRegistry;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: {
        contextRegistry: McpContextRegistry;
        gateway?: McpInstanceGateway;
        instanceName: string;
        worker: McpEndpointWorkerPort;
    }) {
        this.#contextRegistry = options.contextRegistry;
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
    }

    async call(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        exposed: boolean,
        instanceRoutingEnabled: boolean,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        if (!exposed) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }
        const routed = readMcpRoutedInput(input, instanceRoutingEnabled, this.#instanceName);
        const workspace = readMcpWorkspace(routed.input, toolName);
        const { alerts, environment, prepared } = await this.#prepareEnvironment(routed.instance, workspace, signal);
        const record = await this.#contextRegistry.create({
            instance: routed.instance,
            principal: requestContext.principal,
            temporaryDirectory: prepared.temporaryDirectory,
            workspace: prepared.workspace
        });
        try {
            await this.#appendMcpToolCalled(routed.instance, toolName, {
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
                gateway: this.#gateway,
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
                    instance: routed.instance,
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
                targetInstance: routed.instance,
                toolName,
                worker: this.#worker,
            });
        } catch (error) {
            await this.#rollbackUndisclosedContext(
                record.ctxId,
                record.instance,
                record.workspace
            ).catch(() => undefined);
            throw error;
        }
    }

    async #prepareEnvironment(instance: string, workspace: string, signal?: AbortSignal) {
        if (instance === this.#instanceName) {
            const environment = requireMcpEndpointEnvironment(this.#worker, this.#instanceName);
            const prepareWorkspace = this.#worker.prepareWorkspace;
            if (prepareWorkspace === undefined) {
                throw workspacePreparationUnavailable(instance);
            }
            const prepared = await prepareWorkspace.call(this.#worker, workspace);
            const alerts = (await this.#worker.readAlerts(prepared.workspace)).advice;
            return { alerts, environment, prepared };
        }

        const gateway = requireMcpEndpointGateway(this.#gateway, this.#instanceName);
        await waitForMcpGatewayReady(gateway, instance, signal);
        const environment = gateway.environment(instance);
        if (environment === undefined) {
            throw workspacePreparationUnavailable(instance);
        }
        const prepared = await gateway.prepareWorkspace(instance, workspace);
        const alerts = (await gateway.readAlerts(instance, prepared.workspace)).advice;
        return { alerts, environment, prepared };
    }

    async #appendMcpToolCalled(
        instance: string,
        toolName: string,
        context: { requestId?: string; ctxId?: string }
    ): Promise<void> {
        if (instance === this.#instanceName) {
            await this.#worker.appendMcpToolCalled(toolName, context);
            return;
        }
        await requireMcpEndpointGateway(this.#gateway, this.#instanceName).appendMcpToolCalled(
            instance,
            toolName,
            context
        );
    }

    async #rollbackUndisclosedContext(
        ctxId: string,
        instance: string,
        workspace: string
    ): Promise<void> {
        await this.#contextRegistry.discard(ctxId);
        const now = Date.now();
        const hasOtherActiveContext = (await this.#contextRegistry.list()).some((context) =>
            context.status === "active" &&
            Date.parse(context.expiresAt) > now &&
            context.environments.some((environment) =>
                environment.instance === instance && environment.workspace === workspace
            )
        );
        if (hasOtherActiveContext) return;
        if (instance === this.#instanceName) {
            await this.#worker.releaseAlerts?.(workspace);
            return;
        }
        await requireMcpEndpointGateway(this.#gateway, this.#instanceName).releaseAlerts(
            instance,
            workspace
        );
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
