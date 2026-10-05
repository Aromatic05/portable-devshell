import {
    contextErrorCodes,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ContextEnvironment,
    type ContextEnvironmentCleanup,
    type ContextExternalBinding,
} from "@portable-devshell/shared";
import type {
    ContextCleanupLedgerPort,
    ContextRecordPort,
} from "@portable-devshell/shared";

import type { InstanceLease } from "../../instance/Instance.js";
import type { InstanceRegistry } from "../../instance/Registry.js";
import type {
    ContextEnvironmentPort,
    PreparedEnvironmentFacts,
} from "../Port.js";
import { ContextCleanupService } from "./Cleanup.js";

export class ContextEnvironmentService implements ContextEnvironmentPort {
    readonly #registry: ContextRecordPort & ContextCleanupLedgerPort;
    readonly #cleanup: ContextCleanupService;
    readonly #instances: InstanceRegistry;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextRecordPort & ContextCleanupLedgerPort;
        cleanup: ContextCleanupService;
        instances: InstanceRegistry;
    }) {
        this.#registry = options.contextRegistry;
        this.#cleanup = options.cleanup;
        this.#instances = options.instances;
    }

    async prepareLocal(
        ctxId: string,
        instance: string,
        workspace: string,
        options: {
            external?: {
                bindings: readonly ContextExternalBinding[];
                principal: string;
            };
            beforeCommit?: (
                prepared: PreparedEnvironmentFacts,
            ) => Promise<void>;
            signal?: AbortSignal;
        } = {},
    ): Promise<PreparedEnvironmentFacts> {
        const { external, beforeCommit, signal } = options;
        signal?.throwIfAborted();
        return await this.#run(ctxId, async () => {
            await this.#cleanup.reconcile(ctxId);
            const previous = await this.#environment(ctxId, instance);
            const generation = this.#requireGeneration(instance);
            const worker = generation.instance.worker;
            let prepared: PreparedEnvironmentFacts | undefined;
            let attached = false;
            let committed = false;
            try {
                prepared = await worker.prepareWorkspace(workspace);
                await beforeCommit?.(prepared);
                signal?.throwIfAborted();
                await this.#registry.attachEnvironment(
                    ctxId,
                    {
                        instance,
                        workspace: prepared.workspace,
                        temporaryDirectory: prepared.temporaryDirectory,
                    },
                    external,
                );
                attached = true;
                signal?.throwIfAborted();
                committed = true;
                await this.#cleanup.reconcile(ctxId);
                return prepared;
            } catch (error) {
                if (committed) throw error;
                const failures: unknown[] = [];
                if (attached)
                    await this.#restoreEnvironment(
                        ctxId,
                        instance,
                        previous,
                    ).catch((failure) => failures.push(failure));
                if (prepared !== undefined)
                    await this.#releasePreparedWorkspace(
                        ctxId,
                        instance,
                        prepared.workspace,
                    ).catch((failure) => failures.push(failure));
                await this.#cleanup
                    .reconcile(ctxId)
                    .catch((failure) => failures.push(failure));
                if (failures.length > 0)
                    throw new AggregateError(
                        [error, ...failures],
                        `Local environment preparation failed and rollback was incomplete for ${instance}.`,
                    );
                throw error;
            } finally {
                generation.release();
            }
        });
    }

    async ensurePrepared(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<ContextEnvironment> {
        return await this.#run(ctxId, async () => {
            const stored = await this.#environment(ctxId, instance);
            if (
                workspace !== undefined &&
                stored?.workspace !== undefined &&
                stored.workspace !== workspace
            )
                throw new Error(
                    `Workspace ${stored.workspace} is attached to ${ctxId}; switch workspace through environ_info first.`,
                );

            const selected = workspace ?? stored?.workspace;
            if (selected === undefined)
                throw createRemoteError({
                    code: contextErrorCodes.workspaceRequired,
                    details: { ctxId, instance },
                    message: `No workspace is attached to ${instance} for the current Context. Obtain its handle with devshell instance list/status, then use environ_remote command='attach' with an absolute workspace.`,
                    retryable: false,
                });

            const generation = this.#requireGeneration(instance);
            try {
                const worker = generation.instance.worker;
                if (stored?.temporaryDirectory !== undefined) {
                    try {
                        await worker.touchTemporaryDirectory(
                            stored.temporaryDirectory,
                        );
                        return stored;
                    } catch (error) {
                        if (!isRecoverableTemporaryError(error)) throw error;
                    }
                }

                const prepared = await worker.prepareWorkspace(selected);
                const updated = await this.#registry.updateWorkerState(
                    ctxId,
                    instance,
                    {
                        workspace: prepared.workspace,
                        temporaryDirectory: prepared.temporaryDirectory,
                    },
                );
                return updated.environments.find(
                    (environment) => environment.instance === instance,
                )!;
            } finally {
                generation.release();
            }
        });
    }

    async attachRemote(
        ctxId: string,
        handle: string,
        workspace?: string,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        signal?.throwIfAborted();
        const instance = await this.#registry.resolveRemoteInstanceHandle(
            ctxId,
            handle,
        );
        const operation = this.#run(ctxId, async () => {
            await this.#cleanup.reconcile(ctxId);
            const previous = await this.#environment(ctxId, instance);
            const referenceDebt: ContextEnvironmentCleanup | undefined =
                previous === undefined
                    ? { instance, kind: "instance_reference" }
                    : undefined;
            let attached = false;
            let committed = false;
            try {
                if (referenceDebt !== undefined)
                    await this.#registry.recordEnvironmentCleanup(
                        ctxId,
                        referenceDebt,
                    );
                const target = this.#instances.get(instance);
                if (target === undefined)
                    throw createRemoteError({
                        code: runtimeErrorCodes.instanceNotReady,
                        details: { instance },
                        message: `Instance ${instance} is unavailable.`,
                        retryable: false,
                    });
                const { snapshot, worker } =
                    await target.acquireReference(ctxId);
                const connection = snapshot as unknown as Record<
                    string,
                    JsonValue
                >;
                signal?.throwIfAborted();

                if (workspace === undefined) {
                    await this.#registry.attachEnvironment(ctxId, { instance });
                    attached = true;
                    signal?.throwIfAborted();
                    committed = true;
                    return { ...connection, instance };
                }

                if (
                    previous?.workspace === workspace &&
                    previous.temporaryDirectory !== undefined
                ) {
                    try {
                        await worker.touchTemporaryDirectory(
                            previous.temporaryDirectory,
                        );
                        signal?.throwIfAborted();
                        const alerts = await worker.touchAlerts(workspace);
                        return {
                            ...connection,
                            instance,
                            temporaryDirectory: previous.temporaryDirectory,
                            workspace,
                            ...(alerts.advice.length > 0
                                ? {
                                      comment: alerts.advice.map(
                                          ({ text }) => text,
                                      ),
                                  }
                                : {}),
                        };
                    } catch (error) {
                        if (!isRecoverableTemporaryError(error)) throw error;
                    }
                }

                const prepared = await worker.prepareWorkspace(workspace);
                await this.#registry.recordEnvironmentCleanup(ctxId, {
                    instance,
                    kind: "alerts",
                    workspace: prepared.workspace,
                });
                signal?.throwIfAborted();
                const alerts = await worker.readAlerts(prepared.workspace);
                signal?.throwIfAborted();
                await this.#registry.attachEnvironment(ctxId, {
                    instance,
                    workspace: prepared.workspace,
                    temporaryDirectory: prepared.temporaryDirectory,
                });
                attached = true;
                signal?.throwIfAborted();
                committed = true;
                await this.#cleanup.reconcile(ctxId);
                return {
                    ...connection,
                    instance,
                    temporaryDirectory: prepared.temporaryDirectory,
                    workspace: prepared.workspace,
                    comment: alerts.advice.map(({ text }) => text),
                };
            } catch (error) {
                if (committed) throw error;
                const failures: unknown[] = [];
                if (attached)
                    await this.#restoreEnvironment(
                        ctxId,
                        instance,
                        previous,
                    ).catch((failure) => failures.push(failure));
                await this.#cleanup
                    .reconcile(ctxId)
                    .catch((failure) => failures.push(failure));
                if (failures.length > 0)
                    throw new AggregateError(
                        [error, ...failures],
                        `Remote environment attach failed and cleanup was incomplete for ${instance}.`,
                    );
                throw error;
            }
        });
        return await waitAbortable(operation, signal);
    }

    async maskRemote(
        ctxId: string,
        handle: string,
    ): Promise<{ instance: string; masked: true }> {
        return await this.#run(ctxId, async () => {
            const masked = await this.#registry.maskRemoteInstance(
                ctxId,
                handle,
            );
            await this.#cleanup.reconcile(ctxId);
            return { instance: masked.instance, masked: true };
        });
    }

    async rollbackUndisclosed(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<void> {
        if (workspace === undefined) {
            const pending = await this.#registry.listEnvironmentCleanup(ctxId);
            if (pending.length === 0) {
                await this.#registry.discard(ctxId);
                return;
            }
            await this.#registry.disable(ctxId);
            await this.#cleanup.reconcile(ctxId);
            if (
                (await this.#registry.listEnvironmentCleanup(ctxId)).length ===
                0
            )
                await this.#registry.discard(ctxId);
            return;
        }
        await this.#registry.disable(ctxId);
        await this.#registry.recordEnvironmentCleanup(ctxId, {
            instance,
            kind: "alerts",
            workspace,
        });
        await this.#cleanup.reconcile(ctxId);
        if ((await this.#registry.listEnvironmentCleanup(ctxId)).length === 0)
            await this.#registry.discard(ctxId);
    }

    #requireGeneration(instance: string): InstanceLease {
        const target = this.#instances.get(instance);
        if (target === undefined) {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceNotReady,
                details: { instance },
                message: `Instance ${instance} is unavailable.`,
                retryable: false,
            });
        }
        try {
            return target.acquireLease();
        } catch {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceNotReady,
                details: { instance },
                message: `Instance ${instance} is unavailable.`,
                retryable: false,
            });
        }
    }

    async #environment(ctxId: string, instance: string) {
        return await this.#registry.resolveEnvironment(ctxId, instance);
    }

    async #restoreEnvironment(
        ctxId: string,
        instance: string,
        previous?: ContextEnvironment,
    ): Promise<void> {
        if (previous === undefined) {
            await this.#registry.detachEnvironment(ctxId, instance);
            return;
        }
        await this.#registry.attachEnvironment(ctxId, previous);
    }

    async #releasePreparedWorkspace(
        ctxId: string,
        instance: string,
        workspace: string,
    ): Promise<void> {
        await this.#registry.recordEnvironmentCleanup(ctxId, {
            instance,
            kind: "alerts",
            workspace,
        });
    }

    #run<T>(ctxId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.#transactions.get(ctxId) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        const completion = run.then(
            () => undefined,
            () => undefined,
        );
        this.#transactions.set(ctxId, completion);
        void completion.then(() => {
            if (this.#transactions.get(ctxId) === completion)
                this.#transactions.delete(ctxId);
        });
        return run;
    }
}

function isRecoverableTemporaryError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { code?: unknown }).code ===
            "workspace.temporaryUnavailable" ||
            (error as { code?: unknown }).code === "workspace.temporaryInvalid")
    );
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
