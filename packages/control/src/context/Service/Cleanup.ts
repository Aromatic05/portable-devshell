import type {
    ContextCleanupLedgerPort,
    ContextRecordPort,
    McpContextRecord,
} from "@portable-devshell/shared";
import type {
    ContextCleanupPort,
    ContextInstanceCleanupPort,
} from "../Port.js";
export interface ContextPresentationPort {
    revokeContext(ctxId: string): Promise<void>;
    revokeInstance(instance: string): Promise<void>;
}

export interface ContextLifecycleCleanupPort extends ContextCleanupPort {
    bindPresentation(presentation: ContextPresentationPort): void;
    terminate(terminal: McpContextRecord): Promise<void>;
}

import type { McpContextEnvironmentCleanup } from "@portable-devshell/shared";

export class ContextCleanupService {
    readonly #registry: ContextCleanupLedgerPort &
        Pick<ContextRecordPort, "list">;
    #presentation?: ContextPresentationPort;
    readonly #releaseLocalAlerts?: (
        instance: string,
        workspace: string,
    ) => Promise<void>;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextCleanupLedgerPort &
            Pick<ContextRecordPort, "list">;
        releaseLocalAlerts?(instance: string, workspace: string): Promise<void>;
    }) {
        this.#registry = options.contextRegistry;
        this.#releaseLocalAlerts = options.releaseLocalAlerts;
    }

    bindPresentation(presentation: ContextPresentationPort): void {
        this.#presentation = presentation;
    }

    async reconcile(ctxId?: string): Promise<void> {
        if (ctxId === undefined) {
            for (const terminal of await this.#registry.listCleanupPending()) {
                await this.terminate(terminal);
            }
        }
        await this.#reconcile(ctxId);
    }

    async terminate(terminal: McpContextRecord): Promise<void> {
        await this.#run(terminal.ctxId, () => this.#terminate(terminal));
    }


    async reconcileInstance(
        instance: string,
        resources: ContextInstanceCleanupPort,
    ): Promise<void> {
        await this.#reconcile(undefined, { instance, resources });
    }

    async #reconcile(
        ctxId?: string,
        retirement?: {
            instance: string;
            resources: ContextInstanceCleanupPort;
        },
        serialized = false,
    ): Promise<void> {
        const pending = await this.#registry.listEnvironmentCleanup(ctxId);
        const failures: unknown[] = [];
        const scoped =
            retirement === undefined
                ? pending
                : pending.filter(
                      ({ cleanup }) => cleanup.instance === retirement.instance,
                  );
        for (const id of [...new Set(scoped.map(({ ctxId: id }) => id))]) {
            const operation = async () => {
                for (const {
                    cleanup,
                } of await this.#registry.listEnvironmentCleanup(id)) {
                    if (
                        retirement !== undefined &&
                        cleanup.instance !== retirement.instance
                    )
                        continue;
                    try {
                        const settled = await this.#cleanup(
                            id,
                            cleanup,
                            retirement?.resources,
                        );
                        if (settled)
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
        if (failures.length)
            throw new AggregateError(
                failures,
                "Context environment cleanup was incomplete.",
            );
    }

    async #terminate(terminal: McpContextRecord): Promise<void> {
        if (terminal.status === "active") {
            throw new Error(
                "Active Context " +
                    terminal.ctxId +
                    " cannot be terminally cleaned.",
            );
        }
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

        await cleanup(async () => {
            await this.#presentation?.revokeContext(terminal.ctxId);
        });

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
                    "Context " +
                        terminal.ctxId +
                        " was " +
                        terminalReason +
                        ", but cleanup was incomplete.",
                ),
            );
        }
    }

    async #cleanup(
        ctxId: string,
        cleanup: McpContextEnvironmentCleanup,
        retirement?: ContextInstanceCleanupPort,
    ): Promise<boolean> {
        const contexts = await this.#registry.list();
        const now = Date.now();
        if (
            retirement !== undefined &&
            contexts.some(
                (context) =>
                    context.status === "active" &&
                    Date.parse(context.expiresAt) > now &&
                    context.environments.some(
                        (environment) =>
                            environment.instance === cleanup.instance,
                    ),
            )
        ) {
            throw new Error(
                `Instance ${cleanup.instance} still has active Context associations during retirement cleanup.`,
            );
        }
        if (cleanup.kind === "instance_reference") {
            if (
                contexts.some(
                    (context) =>
                        context.ctxId === ctxId &&
                        context.status === "active" &&
                        Date.parse(context.expiresAt) > now &&
                        context.environments.some(
                            (environment) =>
                                environment.instance === cleanup.instance,
                        ),
                )
            )
                return true;
            if (retirement !== undefined) {
                await retirement.releaseInstanceReference(ctxId);
                return true;
            }
        }
        const ownsActiveScope = contexts.some(
            (context) =>
                context.ctxId === ctxId &&
                context.status === "active" &&
                Date.parse(context.expiresAt) > now &&
                context.environments.some(
                    (environment) =>
                        environment.instance === cleanup.instance &&
                        environment.workspace === cleanup.workspace,
                ),
        );
        if (ownsActiveScope) return true;
        if (
            contexts.some(
                (context) =>
                    context.status === "active" &&
                    Date.parse(context.expiresAt) > now &&
                    context.environments.some(
                        (environment) =>
                            environment.instance === cleanup.instance &&
                            environment.workspace === cleanup.workspace,
                    ),
            )
        )
            return false;
        if (cleanup.workspace === undefined)
            throw new Error("Alert cleanup requires a workspace.");
        if (retirement !== undefined) {
            await retirement.releaseAlerts(cleanup.workspace);
            return true;
        }
        if (this.#releaseLocalAlerts !== undefined) {
            await this.#releaseLocalAlerts(cleanup.instance, cleanup.workspace);
            return true;
        }
        throw new Error(
            `Instance ${cleanup.instance} is unavailable for alert cleanup.`,
        );
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
