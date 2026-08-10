import { createError, errorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import { McpContextRegistry } from "../../context/McpContextRegistry.js";
import { readMcpWorkspace } from "../McpEndpointInput.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "../McpEndpointPort.js";
import { mcpEndpointToolNotExposed, requireMcpEndpointEnvironment } from "./McpEndpointHandlerSupport.js";

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
        const environment = requireMcpEndpointEnvironment(this.#worker, this.#instanceName);
        const prepareWorkspace = this.#worker.prepareWorkspace;
        if (prepareWorkspace === undefined) {
            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
                details: { instance: this.#instanceName },
                message: `Workspace preparation is unavailable for ${this.#instanceName}.`,
                retryable: true
            });
        }
        const prepared = await prepareWorkspace.call(this.#worker, workspace);
        const alerts = (await this.#worker.readAlerts(prepared.workspace)).advice;
        const record = await this.#contextRegistry.create({
            instance: this.#instanceName,
            principal: requestContext.principal,
            temporaryDirectory: prepared.temporaryDirectory,
            workspace: prepared.workspace
        });
        await this.#worker.appendMcpToolCalled(toolName, {
            ctxId: record.ctxId,
            requestId: requestContext.requestId
        });
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp"
        };
        return await this.#worker.auditToolCall(
            toolName,
            {},
            context,
            async () => ({
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
            signal
        );
    }
}
