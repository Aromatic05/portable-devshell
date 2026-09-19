import {
    createError,
    errorCodes,
    type JsonValue,
    type McpContextEnvironment,
} from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../endpoint/Port.js";
import type { McpContextMaskedInstance } from "./registry/Model.js";
import type { McpContextRegistry } from "./registry/Registry.js";

export interface McpContextRemoteEnvironmentOptions {
    contextRegistry: McpContextRegistry;
    gateway(instance: string): McpInstanceGateway | undefined;
}

/** Context-owned remote environment attach/mask operations over opaque instance handles. */
export class McpContextRemoteEnvironment {
    readonly #contextRegistry: McpContextRegistry;
    readonly #gateway: (instance: string) => McpInstanceGateway | undefined;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: McpContextRemoteEnvironmentOptions) {
        this.#contextRegistry = options.contextRegistry;
        this.#gateway = options.gateway;
    }

    async attach(
        ctxId: string,
        handle: string,
        workspace?: string,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        signal?.throwIfAborted();
        const operation = this.#runTransaction(ctxId, handle, async () => {
            const instance =
                await this.#contextRegistry.resolveRemoteInstanceHandle(
                    ctxId,
                    handle,
                );
            return await this.#attachTransaction(
                ctxId,
                instance,
                workspace,
                signal,
            );
        });
        return await waitAbortable(operation, signal);
    }

    async #attachTransaction(
        ctxId: string,
        instance: string,
        workspace: string | undefined,
        signal: AbortSignal | undefined,
    ): Promise<JsonValue> {
        signal?.throwIfAborted();
        const gateway = this.#requireGateway(instance);
        const previous = await this.#environment(ctxId, instance);
        let attached = false;
        let connected = false;
        let preparedWorkspace: string | undefined;
        try {
            const connection = await gateway.connectInstance(instance, ctxId);
            connected = true;
            signal?.throwIfAborted();
            if (workspace === undefined) {
                await this.#contextRegistry.attachEnvironment(ctxId, {
                    instance,
                });
                attached = true;
                signal?.throwIfAborted();
                return {
                    ...(isRecord(connection)
                        ? connection
                        : { result: connection }),
                    instance,
                };
            }

            if (
                previous?.workspace === workspace &&
                previous.temporaryDirectory !== undefined
            ) {
                try {
                    await gateway.touchTemporaryDirectory(
                        instance,
                        previous.temporaryDirectory,
                    );
                    signal?.throwIfAborted();
                    await gateway.touchAlerts(instance, workspace);
                    signal?.throwIfAborted();
                    return {
                        ...(isRecord(connection)
                            ? connection
                            : { result: connection }),
                        instance,
                        temporaryDirectory: previous.temporaryDirectory,
                        workspace,
                    };
                } catch (error) {
                    if (!isRecoverableTemporaryError(error)) throw error;
                }
            }

            const prepared = await gateway.prepareWorkspace(instance, workspace);
            signal?.throwIfAborted();
            preparedWorkspace = prepared.workspace;
            const alerts = await gateway.readAlerts(instance, prepared.workspace);
            signal?.throwIfAborted();
            await this.#contextRegistry.attachEnvironment(ctxId, {
                instance,
                temporaryDirectory: prepared.temporaryDirectory,
                workspace: prepared.workspace,
            });
            attached = true;
            signal?.throwIfAborted();
            if (
                previous?.workspace !== undefined &&
                previous.workspace !== prepared.workspace
            ) {
                await this.#releaseAlertsIfUnused(
                    gateway,
                    instance,
                    previous.workspace,
                ).catch(() => undefined);
            }
            const base = isRecord(connection)
                ? connection
                : { result: connection };
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
                    ...alerts.advice.map((advice) => advice.text),
                ],
                instance,
                ...(prepared.projectMemoryPresent !== false
                    ? {
                          projectMemoryAgentFile:
                              prepared.projectMemoryAgentFile,
                          projectMemoryDirectory:
                              prepared.projectMemoryDirectory,
                      }
                    : {}),
                temporaryDirectory: prepared.temporaryDirectory,
                workspace: prepared.workspace,
            };
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            if (attached) {
                await this.#restoreEnvironment(
                    ctxId,
                    instance,
                    previous,
                ).catch((cleanupError) => cleanupFailures.push(cleanupError));
            }
            if (preparedWorkspace !== undefined) {
                await this.#releaseAlertsIfUnused(
                    gateway,
                    instance,
                    preparedWorkspace,
                ).catch((cleanupError) => cleanupFailures.push(cleanupError));
            }
            if (connected && previous === undefined) {
                try {
                    await gateway.releaseInstanceReference?.(instance, ctxId);
                } catch (cleanupError) {
                    cleanupFailures.push(cleanupError);
                }
            }
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    `Remote environment attach failed and cleanup was incomplete for ${instance}.`,
                );
            }
            throw error;
        }
    }

    async mask(
        ctxId: string,
        handle: string,
    ): Promise<{ instance: string; masked: true }> {
        return await this.#runTransaction(ctxId, handle, async () => {
            const masked = await this.#contextRegistry.maskRemoteInstance(
                ctxId,
                handle,
            );
            return await this.#maskTransaction(ctxId, masked);
        });
    }

    async #maskTransaction(
        ctxId: string,
        masked: McpContextMaskedInstance,
    ): Promise<{ instance: string; masked: true }> {
        if (masked.environment !== undefined) {
            const gateway = this.#gateway(masked.instance);
            if (gateway !== undefined) {
                await gateway
                    .releaseInstanceReference?.(masked.instance, ctxId)
                    .catch(() => undefined);
                if (masked.environment.workspace !== undefined) {
                    await this.#releaseAlertsIfUnused(
                        gateway,
                        masked.instance,
                        masked.environment.workspace,
                    ).catch(() => undefined);
                }
            }
        }
        return { instance: masked.instance, masked: true };
    }

    async #restoreEnvironment(
        ctxId: string,
        instance: string,
        previous: McpContextEnvironment | undefined,
    ): Promise<void> {
        if (previous === undefined) {
            await this.#contextRegistry.detachEnvironment(ctxId, instance);
            return;
        }
        await this.#contextRegistry.attachEnvironment(ctxId, previous);
    }

    #runTransaction<T>(
        ctxId: string,
        handle: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const key = `${ctxId}\0${handle}`;
        const previous = this.#transactions.get(key) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        const completion = run.then(
            () => undefined,
            () => undefined,
        );
        this.#transactions.set(key, completion);
        void completion.then(() => {
            if (this.#transactions.get(key) === completion)
                this.#transactions.delete(key);
        });
        return run;
    }

    #requireGateway(instance: string): McpInstanceGateway {
        const gateway = this.#gateway(instance);
        if (gateway !== undefined) return gateway;
        throw createError({
            code: errorCodes.coreToolSchemaUnavailable,
            details: { instance },
            message: `Remote environment attachment is not available for ${instance}.`,
            retryable: false,
        });
    }

    async #environment(
        ctxId: string,
        instance: string,
    ): Promise<McpContextEnvironment | undefined> {
        const record = (await this.#contextRegistry.list()).find(
            (context) => context.ctxId === ctxId && context.status === "active",
        );
        return record?.environments.find(
            (environment) => environment.instance === instance,
        );
    }

    async #releaseAlertsIfUnused(
        gateway: McpInstanceGateway,
        instance: string,
        workspace: string,
    ): Promise<void> {
        const inUse = (await this.#contextRegistry.list()).some(
            (context) =>
                context.status === "active" &&
                context.environments.some(
                    (environment) =>
                        environment.instance === instance &&
                        environment.workspace === workspace,
                ),
        );
        if (!inUse) await gateway.releaseAlerts(instance, workspace);
    }
}

async function waitAbortable<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (signal === undefined) return await operation;
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        abort = () =>
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Remote environment operation was cancelled."),
            );
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
    if (typeof error !== "object" || error === null || !("code" in error))
        return false;
    const code = (error as { code?: unknown }).code;
    return (
        code === "workspace.temporaryUnavailable" ||
        code === "workspace.temporaryInvalid"
    );
}
