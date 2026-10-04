import {
    createRemoteError,
    contextErrorCodes,
    runtimeErrorCodes,
    type JsonValue,
    type McpContextEnvironment,
    type McpContextEnvironmentCleanup,
    type McpContextExternalBinding,
} from "@portable-devshell/shared";
import type {
    ContextCleanupLedgerPort,
    ContextRecordPort,
} from "@portable-devshell/shared";
import type {
    ContextEnvironmentPort,
    ContextInstancePort,
    ContextWorkerPort,
    PreparedEnvironmentFacts,
} from "../Port.js";
import { ContextCleanupService } from "./Cleanup.js";

export class ContextEnvironmentService implements ContextEnvironmentPort {
    readonly #registry: ContextRecordPort & ContextCleanupLedgerPort;
    readonly #gateway: (instance: string) => ContextInstancePort | undefined;
    readonly #worker: (instance: string) => ContextWorkerPort | undefined;
    readonly #cleanup: ContextCleanupService;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextRecordPort & ContextCleanupLedgerPort;
        gateway(instance: string): ContextInstancePort | undefined;
        worker(instance: string): ContextWorkerPort | undefined;
        cleanup: ContextCleanupService;
    }) {
        this.#registry = options.contextRegistry;
        this.#gateway = options.gateway;
        this.#worker = options.worker;
        this.#cleanup = options.cleanup;
    }

    async prepareLocal(
        ctxId: string,
        instance: string,
        workspace: string,
        options: {
            external?: {
                bindings: readonly McpContextExternalBinding[];
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
            const worker = this.#worker(instance);
            if (worker?.prepareWorkspace === undefined)
                throw new Error(
                    `Workspace preparation is unavailable for ${instance}.`,
                );
            let prepared: PreparedEnvironmentFacts | undefined;
            let attached = false;
            let committed = false;
            try {
                prepared = await worker.prepareWorkspace(workspace);
                if (
                    previous?.workspace !== undefined &&
                    previous.workspace !== prepared.workspace
                ) {
                    await this.#assertWorkspaceSwitchAvailable(
                        ctxId,
                        instance,
                        previous.workspace,
                    );
                }
                await beforeCommit?.(prepared);
                signal?.throwIfAborted();
                if (this.#worker(instance) !== worker) {
                    throw new Error(
                        `Instance ${instance} was retired or replaced while preparing its environment.`,
                    );
                }
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
                if (failures.length)
                    throw new AggregateError(
                        [error, ...failures],
                        `Local environment preparation failed and rollback was incomplete for ${instance}.`,
                    );
                throw error;
            }
        });
    }

    async ensurePrepared(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<McpContextEnvironment> {
        return await this.#run(ctxId, async () => {
            const stored = await this.#environment(ctxId, instance);
            if (
                workspace !== undefined &&
                stored?.workspace !== undefined &&
                stored.workspace !== workspace
            ) {
                await this.#assertWorkspaceSwitchAvailable(
                    ctxId,
                    instance,
                    stored.workspace,
                );
                throw new Error(
                    `Workspace ${stored.workspace} is attached to ${ctxId}; switch workspace through environ_info first.`,
                );
            }
            const selected = workspace ?? stored?.workspace;
            if (selected === undefined) {
                throw createRemoteError({
                    code: contextErrorCodes.workspaceRequired,
                    details: { ctxId, instance },
                    message: `No workspace is attached to ${instance} for the current Context. Obtain its handle with devshell instance list/status, then use environ_remote command='attach' with an absolute workspace.`,
                    retryable: false,
                });
            }
            if (stored?.temporaryDirectory !== undefined) {
                try {
                    const gateway = this.#gateway(instance);
                    if (
                        this.#worker(instance)?.touchTemporaryDirectory !==
                        undefined
                    )
                        await this.#worker(instance)!.touchTemporaryDirectory!(
                            stored.temporaryDirectory,
                        );
                    else
                        await gateway?.touchTemporaryDirectory(
                            instance,
                            stored.temporaryDirectory,
                        );
                    return stored;
                } catch (error) {
                    if (!isRecoverableTemporaryError(error)) throw error;
                }
            }
            const prepared = await this.#prepareWorkspace(instance, selected);
            if (prepared === undefined)
                return stored ?? { instance, workspace: selected };
            this.#requireGateway(instance).assertReady(instance);
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
            const gateway = this.#requireGateway(instance);
            const previous = await this.#environment(ctxId, instance);
            const referenceDebt: McpContextEnvironmentCleanup | undefined =
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
                const connection = await gateway.connectInstance(
                    instance,
                    ctxId,
                );
                signal?.throwIfAborted();
                if (workspace === undefined) {
                    gateway.assertReady(instance);
                    await this.#registry.attachEnvironment(ctxId, { instance });
                    attached = true;
                    signal?.throwIfAborted();
                    committed = true;
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
                        const alerts = await gateway.touchAlerts(
                            instance,
                            workspace,
                        );
                        return {
                            ...(isRecord(connection)
                                ? connection
                                : { result: connection }),
                            instance,
                            temporaryDirectory: previous.temporaryDirectory,
                            workspace,
                            ...(alerts?.advice.length
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
                const prepared = await gateway.prepareWorkspace(
                    instance,
                    workspace,
                );
                await this.#registry.recordEnvironmentCleanup(ctxId, {
                    instance,
                    kind: "alerts",
                    workspace: prepared.workspace,
                });
                signal?.throwIfAborted();
                if (
                    previous?.workspace !== undefined &&
                    previous.workspace !== prepared.workspace
                ) {
                    await this.#assertWorkspaceSwitchAvailable(
                        ctxId,
                        instance,
                        previous.workspace,
                    );
                }
                const alerts = await gateway.readAlerts(
                    instance,
                    prepared.workspace,
                );
                signal?.throwIfAborted();
                gateway.assertReady(instance);
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
                    ...(isRecord(connection)
                        ? connection
                        : { result: connection }),
                    instance,
                    temporaryDirectory: prepared.temporaryDirectory,
                    workspace: prepared.workspace,
                    comment: [...alerts.advice.map(({ text }) => text)],
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
                if (failures.length)
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
            ) {
                await this.#registry.discard(ctxId);
            }
            return;
        }
        await this.#registry.disable(ctxId);
        await this.#registry.recordEnvironmentCleanup(ctxId, {
            instance,
            kind: "alerts",
            workspace,
        });
        await this.#cleanup.reconcile(ctxId);
        if ((await this.#registry.listEnvironmentCleanup(ctxId)).length === 0) {
            await this.#registry.discard(ctxId);
        }
    }

    async #assertWorkspaceSwitchAvailable(
        ctxId: string,
        instance: string,
        previousWorkspace?: string,
    ): Promise<void> {
        if (previousWorkspace === undefined) return;
        const gateway = this.#gateway(instance);
        if (
            gateway?.readGoal !== undefined &&
            gateway.manageGoal !== undefined
        ) {
            const goal = await gateway.readGoal(instance, ctxId);
            if (goal?.status === "active" || goal?.status === "blocked")
                throw new Error(
                    `Workspace Goal ${goal.goalId} is still ${goal.status} in ${goal.workspace ?? previousWorkspace}; finish or stop it before switching workspace.`,
                );
        }
        const waits = (await gateway?.listWaits?.(instance)) ?? [];
        const blocking = waits.find(
            (wait) =>
                wait.createdByCtxId === ctxId &&
                (wait.workspace === undefined ||
                    wait.workspace === previousWorkspace) &&
                wait.automaticRecovery !== false &&
                wait.recoveryDisabledAt === undefined &&
                wait.status !== "consumed" &&
                wait.status !== "cancelled",
        );
        if (blocking !== undefined)
            throw new Error(
                `Workspace wait ${blocking.waitId} is still attached to ${previousWorkspace}; finish or stop its owner before switching workspace.`,
            );
    }

    async #prepareWorkspace(instance: string, workspace: string) {
        if (this.#worker(instance)?.prepareWorkspace !== undefined)
            return await this.#worker(instance)!.prepareWorkspace!(workspace);
        return await this.#gateway(instance)?.prepareWorkspace(
            instance,
            workspace,
        );
    }

    async #environment(ctxId: string, instance: string) {
        return await this.#registry.resolveEnvironment(ctxId, instance);
    }

    async #restoreEnvironment(
        ctxId: string,
        instance: string,
        previous?: McpContextEnvironment,
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

    #requireGateway(instance: string): ContextInstancePort {
        const gateway = this.#gateway(instance);
        if (gateway !== undefined) return gateway;
        throw createRemoteError({
            code: runtimeErrorCodes.toolSchemaUnavailable,
            details: { instance },
            message: `Remote environment attachment is not available for ${instance}.`,
            retryable: false,
        });
    }

    #run<T>(ctxId: string, operation: () => Promise<T>): Promise<T> {
        const key = ctxId;
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
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
