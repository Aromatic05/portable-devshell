import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

import { McpContextRegistry } from "../../context/McpContextRegistry.js";
import { assertMcpNoArguments } from "../McpEndpointInput.js";
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
        assertMcpNoArguments(input, toolName);
        const environment = requireMcpEndpointEnvironment(this.#worker, this.#instanceName);
        const record = await this.#contextRegistry.create({
            instance: this.#instanceName,
            principal: requestContext.principal,
            workspace: environment.workspace
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
                instance: this.#instanceName,
                platform: {
                    arch: environment.platform.arch,
                    ...(environment.platform.distribution === undefined ? {} : { distribution: environment.platform.distribution }),
                    os: environment.platform.os,
                    ...(environment.platform.packageManager === undefined ? {} : { packageManager: environment.platform.packageManager }),
                    ...(environment.platform.shell === undefined ? {} : { shell: environment.platform.shell.kind })
                },
                workspace: environment.workspace
            }),
            signal
        );
    }
}
