import type { ContextEnvironmentCleanup, ContextRecord, EnvironmentTransport, InstanceRuntimeTransport, } from "@portable-devshell/shared";

import type {
    ContextCleanupLedgerPort, ContextInstanceCleanupPort, ContextLifecycleCleanupPort, ContextRecordPort, } from "../Api.js";

export class ContextCleanupService implements ContextLifecycleCleanupPort {
    readonly #registry: ContextCleanupLedgerPort &
        Pick<ContextRecordPort, "list">;
    readonly #environment: (instance: string) => EnvironmentTransport;
    readonly #runtime: (instance: string) => InstanceRuntimeTransport;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextCleanupLedgerPort &
            Pick<ContextRecordPort, "list">;
        environment(instance: string): EnvironmentTransport;
        runtime(instance: string): InstanceRuntimeTransport;
    }) {
        this.#registry = options.contextRegistry;
        this.#environment = options.environment;
        this.#runtime = options.runtime;
    }

    async reconcile(ctxId?: string): Promise<void> {
        if (ctxId === undefined) {
            // Startup reconciliation is maintenance, not a prerequisite for
            // using live Contexts. Preserve debt and continue on ledger errors.
            try {
                for (const terminal of await this.#registry.listCleanupPending())
                    await this.terminate(terminal).catch((error) => {
                        console.warn(`Deferred Context ${terminal.ctxId} cleanup:`, error);
                    });
            } catch (error) {
                console.warn("Deferred Context cleanup ledger inspection:", error);
            }
            await this.#reconcile(undefined, undefined, false, undefined, true)
                .catch((error) => {
                    console.warn("Deferred Context cleanup ledger reconciliation:", error);
                });
            return;
        }
        await this.#reconcile(ctxId);
    }

    async reconcileInstance(
        instance: string,
        target?: ContextInstanceCleanupPort,
    ): Promise<void> {
        await this.#reconcile(undefined, instance, false, target);
    }

    async terminate(terminal: ContextRecord): Promise<void> {
        await this.#run(terminal.ctxId, () => this.#terminate(terminal));
    }

    async #terminate(terminal: ContextRecord): Promise<void> {
        if (terminal.status === "active")
            throw new Error(
                `Active Context ${terminal.ctxId} cannot be terminally cleaned.`,
            );

        const failures: unknown[] = [];
        const cleanup = async (
            operation: () => Promise<unknown> | unknown,
        ): Promise<void> => {
            try {
                await operation();
            } catch (error) {
                failures.push(error);
            }
        };
        const terminalReason =
            terminal.status === "disabled" ? "disabled" : "expired";

        for (const environment of terminal.environments) {
            if (environment.workspace !== undefined) {
                await cleanup(async () => {
                    await this.#registry.recordEnvironmentCleanup(
                        terminal.ctxId,
                        {
                            instance: environment.instance,
                            kind: "alerts",
                            workspace: environment.workspace!,
                        },
                    );
                });
            }
            await cleanup(async () => {
                await this.#registry.recordEnvironmentCleanup(terminal.ctxId, {
                    instance: environment.instance,
                    kind: "instance_reference",
                });
            });
        }

        await cleanup(async () => {
            await this.#reconcile(terminal.ctxId, undefined, true);
        });
        if (failures.length === 0) {
            await cleanup(async () => {
                const pending = await this.#registry.listEnvironmentCleanup(
                    terminal.ctxId,
                );
                if (pending.length === 0)
                    await this.#registry.settleCleanup(terminal.ctxId);
            });
        }
        if (failures.length > 0) {
            console.warn(
                new AggregateError(
                    failures,
                    `Context ${terminal.ctxId} was ${terminalReason}, but cleanup was incomplete.`,
                ),
            );
        }
    }

    async #reconcile(
        ctxId?: string,
        instance?: string,
        serialized = false,
        target?: ContextInstanceCleanupPort,
        deferRemoteFailures = false,
    ): Promise<void> {
        const pending = await this.#registry.listEnvironmentCleanup(ctxId);
        const scoped =
            instance === undefined
                ? pending
                : pending.filter(
                      ({ cleanup }) => cleanup.instance === instance,
                  );
        const failures: unknown[] = [];
        for (const id of [
            ...new Set(scoped.map(({ ctxId: value }) => value)),
        ]) {
            const operation = async () => {
                for (const {
                    cleanup,
                } of await this.#registry.listEnvironmentCleanup(id)) {
                    if (instance !== undefined && cleanup.instance !== instance)
                        continue;
                    // Ledger reads/writes are not remote cleanup failures.
                    const contexts = await this.#registry.list();
                    let cleaned: boolean;
                    try {
                        cleaned = await this.#cleanup(id, cleanup, contexts, target);
                    } catch (error) {
                        failures.push(error);
                        continue;
                    }
                    if (cleaned)
                        await this.#registry.settleEnvironmentCleanup(id, cleanup);
                }
            };
            if (serialized) await operation();
            else {
                try {
                    await this.#run(id, operation);
                } catch (error) {
                    if (!deferRemoteFailures) throw error;
                    failures.push(error);
                }
            }
        }
        if (failures.length > 0) {
            const error = new AggregateError(
                failures,
                "Context environment cleanup was incomplete.",
            );
            if (deferRemoteFailures) console.warn("Context cleanup deferred; debt retained:", error);
            else throw error;
        }
    }

    async #cleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
        contexts: readonly ContextRecord[],
        target?: ContextInstanceCleanupPort,
    ): Promise<boolean> {
        const now = Date.now();
        const active = (context: ContextRecord) =>
            context.status === "active" && Date.parse(context.expiresAt) > now;

        if (cleanup.kind === "instance_reference") {
            const stillOwned = contexts.some(
                (context) =>
                    context.ctxId === ctxId &&
                    active(context) &&
                    context.environments.some(
                        (environment) =>
                            environment.instance === cleanup.instance,
                    ),
            );
            if (stillOwned) return true;
            if (target !== undefined) await target.releaseReference(ctxId);
            else await this.#runtime(cleanup.instance).releaseReference(ctxId);
            return true;
        }

        const ownsActiveScope = contexts.some(
            (context) =>
                context.ctxId === ctxId &&
                active(context) &&
                context.environments.some(
                    (environment) =>
                        environment.instance === cleanup.instance &&
                        environment.workspace === cleanup.workspace,
                ),
        );
        if (ownsActiveScope) return true;

        const sharedScope = contexts.some(
            (context) =>
                active(context) &&
                context.environments.some(
                    (environment) =>
                        environment.instance === cleanup.instance &&
                        environment.workspace === cleanup.workspace,
                ),
        );
        if (sharedScope) return false;
        if (cleanup.workspace === undefined)
            throw new Error("Alert cleanup requires a workspace.");

        if (target !== undefined) await target.releaseAlerts(cleanup.workspace);
        else await this.#environment(cleanup.instance).releaseAlerts(cleanup.workspace);
        return true;
    }

    async #run(ctxId: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.#transactions.get(ctxId) ?? Promise.resolve();
        const current = previous.then(operation, operation);
        const completion = current.then(
            () => undefined,
            () => undefined,
        );
        this.#transactions.set(ctxId, completion);
        try {
            await current;
        } finally {
            if (this.#transactions.get(ctxId) === completion)
                this.#transactions.delete(ctxId);
        }
    }
}
