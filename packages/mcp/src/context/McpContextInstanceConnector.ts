import {
    createError,
    errorCodes,
    type JsonValue,
    type McpContextEnvironment
} from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import type { McpContextRegistry } from "./McpContextRegistry.js";

export interface McpContextInstanceConnectorOptions {
    contextRegistry: McpContextRegistry;
    gateway(instance: string): McpInstanceGateway | undefined;
}

/** Attaches managed instances to an existing Context without exposing Context ids to Extensions. */
export class McpContextInstanceConnector {
    readonly #contextRegistry: McpContextRegistry;
    readonly #gateway: (instance: string) => McpInstanceGateway | undefined;

    constructor(options: McpContextInstanceConnectorOptions) {
        this.#contextRegistry = options.contextRegistry;
        this.#gateway = options.gateway;
    }

    async connect(
        ctxId: string,
        instance: string,
        workspace?: string,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        signal?.throwIfAborted();
        const gateway = this.#requireGateway(instance);
        const previous = await this.#environment(ctxId, instance);
        const connected = await waitAbortable(gateway.connectInstance(instance, ctxId), signal);
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
                await waitAbortable(
                    gateway.touchTemporaryDirectory(instance, previous.temporaryDirectory),
                    signal
                );
                await waitAbortable(gateway.touchAlerts(instance, workspace), signal);
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
            const prepared = await waitAbortable(gateway.prepareWorkspace(instance, workspace), signal);
            preparedWorkspace = prepared.workspace;
            const alerts = await waitAbortable(gateway.readAlerts(instance, prepared.workspace), signal);
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
                              `Use ${prepared.projectMemoryDirectory} for durable project memory; keep it useful for future sessions.`
                          ]
                        : []),
                    `Use ${prepared.temporaryDirectory} for all temporary files.`,
                    ...alerts.advice.map((advice) => advice.text)
                ],
                ...(prepared.projectMemoryPresent !== false
                    ? {
                          projectMemoryAgentFile: prepared.projectMemoryAgentFile,
                          projectMemoryDirectory: prepared.projectMemoryDirectory
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

    #requireGateway(instance: string): McpInstanceGateway {
        const gateway = this.#gateway(instance);
        if (gateway !== undefined) return gateway;
        throw createError({
            code: errorCodes.coreToolSchemaUnavailable,
            details: { instance },
            message: `Context instance attachment is not available for ${instance}.`,
            retryable: false
        });
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

async function waitAbortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return await operation;
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Model command was cancelled."));
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecoverableTemporaryError(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    const code = (error as { code?: unknown }).code;
    return code === "workspace.temporaryUnavailable" || code === "workspace.temporaryInvalid";
}
