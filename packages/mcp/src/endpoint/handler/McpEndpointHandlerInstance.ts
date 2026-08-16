import { createError, errorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import type { McpContextRegistry } from "../../context/McpContextRegistry.js";
import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogInstanceName } from "../../tool/catalog/McpToolCatalogInstance.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import {
    assertMcpNoArguments,
    readMcpInstanceConnectInput,
    readMcpInstanceName,
    readMcpSshCreateInput
} from "../McpEndpointInput.js";
import { requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerInstance {
    readonly #contextRegistry: McpContextRegistry;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;

    constructor(options: {
        contextRegistry: McpContextRegistry;
        gateway?: McpInstanceGateway;
        instanceName: string;
    }) {
        this.#contextRegistry = options.contextRegistry;
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
    }

    async call(
        toolName: McpToolCatalogInstanceName,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = requireMcpEndpointGateway(this.#gateway, this.#instanceName);
        switch (toolName) {
            case "instance_list":
                assertMcpNoArguments(input, toolName);
                return { instances: await waitForMcpEndpointAbortable(gateway.listInstances(), signal) };
            case "instance_status":
                return await waitForMcpEndpointAbortable(gateway.statusInstance(readMcpInstanceName(input, toolName)), signal);
            case "instance_connect":
                return await this.#connect(gateway, input, context, signal);
            case "instance_stop":
                return await waitForMcpEndpointAbortable(gateway.stopInstance(readMcpInstanceName(input, toolName)), signal);
            case "instance_create":
                return await waitForMcpEndpointAbortable(
                    gateway.createSshInstance(this.#instanceName, readMcpSshCreateInput(input)),
                    signal
                );
        }
    }

    async #connect(
        gateway: McpInstanceGateway,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const ctxId = requireCtxId(context);
        const { instance, workspace } = readMcpInstanceConnectInput(input);
        const connected = await waitForMcpEndpointAbortable(gateway.connectInstance(instance, ctxId), signal);
        try {
            if (workspace === undefined) {
                await this.#contextRegistry.attachEnvironment(ctxId, { instance });
                return connected;
            }

            const prepared = await waitForMcpEndpointAbortable(gateway.prepareWorkspace(instance, workspace), signal);
            const alerts = await waitForMcpEndpointAbortable(gateway.readAlerts(instance, prepared.workspace), signal);
            await this.#contextRegistry.attachEnvironment(ctxId, {
                instance,
                temporaryDirectory: prepared.temporaryDirectory,
                workspace: prepared.workspace
            });
            const base = isRecord(connected) ? connected : { result: connected };
            return {
                ...base,
                comment: [
                    `Read ${prepared.projectMemoryAgentFile} before working.`,
                    `Use ${prepared.projectMemoryDirectory} for durable project memory; keep it useful for future sessions.`,
                    `Use ${prepared.temporaryDirectory} for all temporary files.`,
                    ...alerts.advice.map((advice) => advice.text)
                ],
                projectMemoryAgentFile: prepared.projectMemoryAgentFile,
                projectMemoryDirectory: prepared.projectMemoryDirectory,
                temporaryDirectory: prepared.temporaryDirectory,
                workspace: prepared.workspace
            };
        } catch (error) {
            await gateway.releaseInstanceReference?.(instance, ctxId);
            throw error;
        }
    }
}

function requireCtxId(context: ToolCallContext): string {
    if (context.ctxId !== undefined && context.ctxId.length > 0) return context.ctxId;
    throw createError({
        code: errorCodes.mcpContextInvalid,
        message: "instance_connect requires a validated ctxId.",
        retryable: false
    });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
