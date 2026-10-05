import type {
    ContextCleanupLedgerPort,
    ContextRecordPort,
    ContextEnvironmentCleanup,
    ContextRecord,
} from "@portable-devshell/shared";

import type { ContextInstanceLeasePort, ContextInstancesPort } from "../Api.js";
import type { ContextLifecycleCleanupPort } from "../Api.js";

export class ContextCleanupService implements ContextLifecycleCleanupPort {
    readonly #registry: ContextCleanupLedgerPort &
        Pick<ContextRecordPort, "list">;
    readonly #instances: ContextInstancesPort;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextCleanupLedgerPort &
            Pick<ContextRecordPort, "list">;
        instances: ContextInstancesPort;
    }) {
        this.#registry = options.contextRegistry;
        this.#instances = options.instances;
    }

    async reconcile(ctxId?: string): Promise<void> {
        if (ctxId === undefined) {
            for (const terminal of await this.#registry.listCleanupPending())
                await this.terminate(terminal);
        }
        await this.#reconcile(ctxId);
    }

    async reconcileInstance(instance: string): Promise<void> {
        await this.#reconcile(undefined, instance);
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
                    try {
                        if (await this.#cleanup(id, cleanup))
                            await this.#registry.settleEnvironmentCleanup(
                                id,
                                cleanup,
                            );
                    } catch (error) {
                        failures.push(error);
                    }
                }
            };
            if (serialized) await operation();
            else await this.#run(id, operation);
        }
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                "Context environment cleanup was incomplete.",
            );
    }

    async #cleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
    ): Promise<boolean> {
        const contexts = await this.#registry.list();
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
            await this.#instances.get(cleanup.instance)?.releaseReference(ctxId);
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

        const instance = this.#instances.get(cleanup.instance);
        if (instance === undefined)
            throw new Error(
                `Instance ${cleanup.instance} is unavailable for alert cleanup.`,
            );
        let lease: ContextInstanceLeasePort;
        try {
            lease = instance.acquireLease();
        } catch {
            throw new Error(
                `Instance ${cleanup.instance} is unavailable for alert cleanup.`,
            );
        }
        try {
            await lease.instance.worker.releaseAlerts(cleanup.workspace);
        } finally {
            lease.release();
        }
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
