import { createError, errorCodes, type JsonValue, type McpContextEnvironment, type ToolCallContext } from "@portable-devshell/shared";

import type { McpContextRegistry } from "../../context/McpContextRegistry.js";
import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogInstanceName } from "../../tool/catalog/McpToolCatalogInstance.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { readMcpInstanceConnectInput } from "../McpEndpointInput.js";
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
        return await this.#connect(gateway, input, context, signal);
    }

    async #connect(
        gateway: McpInstanceGateway,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const ctxId = requireCtxId(context);
        const { instance, workspace } = readMcpInstanceConnectInput(input);
        const previous = await this.#environment(ctxId, instance);
        const connected = await waitForMcpEndpointAbortable(gateway.connectInstance(instance, ctxId), signal);
        if (workspace === undefined) {
            try {
                await this.#contextRegistry.attachEnvironment(ctxId, { instance });
                return connected;
            } catch (error) {
                if (previous === undefined) await gateway.releaseInstanceReference?.(instance, ctxId);
                throw error;
            }
        }

        if (previous?.workspace === workspace && previous.temporaryDirectory !== undefined) {
            try {
                await waitForMcpEndpointAbortable(
                    gateway.touchTemporaryDirectory(instance, previous.temporaryDirectory),
                    signal
                );
                await waitForMcpEndpointAbortable(gateway.touchAlerts(instance, workspace), signal);
                return {
                    ...(isRecord(connected) ? connected : { result: connected }),
                    temporaryDirectory: previous.temporaryDirectory,
                    workspace
                };
            } catch (error) {
                if (!isRecoverableTemporaryError(error)) throw error;
            }
        }

        let preparedWorkspace: string | undefined;
        try {
            const prepared = await waitForMcpEndpointAbortable(gateway.prepareWorkspace(instance, workspace), signal);
            preparedWorkspace = prepared.workspace;
            const alerts = await waitForMcpEndpointAbortable(gateway.readAlerts(instance, prepared.workspace), signal);
            await this.#contextRegistry.attachEnvironment(ctxId, {
                instance,
                temporaryDirectory: prepared.temporaryDirectory,
                workspace: prepared.workspace
            });
            if (previous?.workspace !== undefined && previous.workspace !== prepared.workspace) {
                await this.#releaseAlertsIfUnused(gateway, instance, previous.workspace).catch(() => undefined);
            }
            const base = isRecord(connected) ? connected : { result: connected };
            return {
                ...base,
                comment: [
                    ...(prepared.projectMemoryPresent !== false
                        ? [
                              `Read ${prepared.projectMemoryAgentFile} before working.`,
                              `Use ${prepared.projectMemoryDirectory} for durable project memory; keep it useful for future sessions.`,
                          ]
                        : []),
                    `Use ${prepared.temporaryDirectory} for all temporary files.`,
                    ...alerts.advice.map((advice) => advice.text)
                ],
                ...(prepared.projectMemoryPresent !== false
                    ? {
                          projectMemoryAgentFile: prepared.projectMemoryAgentFile,
                          projectMemoryDirectory: prepared.projectMemoryDirectory,
                      }
                    : {}),
                temporaryDirectory: prepared.temporaryDirectory,
                workspace: prepared.workspace
            };
        } catch (error) {
            if (preparedWorkspace !== undefined) {
                await this.#releaseAlertsIfUnused(gateway, instance, preparedWorkspace).catch(() => undefined);
            }
            if (previous === undefined) await gateway.releaseInstanceReference?.(instance, ctxId);
            throw error;
        }
    }

    async #environment(ctxId: string, instance: string): Promise<McpContextEnvironment | undefined> {
        const record = (await this.#contextRegistry.list()).find((context) =>
            context.ctxId === ctxId && context.status === "active"
        );
        return record?.environments.find((environment) => environment.instance === instance);
    }

    async #releaseAlertsIfUnused(
        gateway: McpInstanceGateway,
        instance: string,
        workspace: string
    ): Promise<void> {
        const inUse = (await this.#contextRegistry.list()).some((context) =>
            context.status === "active" && context.environments.some((environment) =>
                environment.instance === instance && environment.workspace === workspace
            )
        );
        if (!inUse) await gateway.releaseAlerts(instance, workspace);
    }
}

function requireCtxId(context: ToolCallContext): string {
    if (context.ctxId !== undefined && context.ctxId.length > 0) return context.ctxId;
    throw createError({
        code: errorCodes.mcpContextInvalid,
        message: "instance_connect requires a validated Context.",
        retryable: false
    });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecoverableTemporaryError(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    const code = (error as { code?: unknown }).code;
    return code === "workspace.temporaryUnavailable" || code === "workspace.temporaryInvalid";
}
