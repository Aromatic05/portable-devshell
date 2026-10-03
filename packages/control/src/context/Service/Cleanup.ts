import { isMcpGoalGateway } from "@portable-devshell/mcp";
import type {
    ContextCleanupLedgerPort,
    ContextRecordPort,
    McpContextRecord,
} from "@portable-devshell/shared";
import type { ContextCleanupPort } from "@portable-devshell/mcp";
export interface ContextPresentationPort {
    revokeContext(ctxId: string): Promise<void>;
    revokeInstance(instance: string): Promise<void>;
}

export interface ContextLifecycleCleanupPort extends ContextCleanupPort {
    bindPresentation(presentation: ContextPresentationPort): void;
    terminate(terminal: McpContextRecord): Promise<void>;
}

import type { McpContextEnvironmentCleanup } from "@portable-devshell/shared";
import type { McpInstanceGateway } from "@portable-devshell/mcp";
import type { ContextInstanceCleanupPort } from "../../../../mcp/src/context/Port.js";

export class ContextCleanupService {
    readonly #registry: ContextCleanupLedgerPort &
        Pick<ContextRecordPort, "list">;
    #presentation?: ContextPresentationPort;
    readonly #gateway: (instance: string) => McpInstanceGateway | undefined;
    readonly #releaseLocalAlerts?: (
        instance: string,
        workspace: string,
    ) => Promise<void>;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextCleanupLedgerPort &
            Pick<ContextRecordPort, "list">;
        gateway(instance: string): McpInstanceGateway | undefined;
        releaseLocalAlerts?(instance: string, workspace: string): Promise<void>;
    }) {
        this.#registry = options.contextRegistry;
        this.#gateway = options.gateway;
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

        const reconciledInstances = new Set<string>();
        for (const environment of terminal.environments) {
            const gateway = this.#gateway(environment.instance);
            if (
                gateway !== undefined &&
                !reconciledInstances.has(environment.instance)
            ) {
                reconciledInstances.add(environment.instance);
                if (isMcpGoalGateway(gateway)) {
                    const goal = await gateway
                        .readGoal(environment.instance, terminal.ctxId)
                        .catch((error) => {
                            failures.push(error);
                            return undefined;
                        });
                    if (
                        goal?.status === "active" ||
                        goal?.status === "blocked"
                    ) {
                        await cleanup(async () => {
                            await gateway.manageGoal(
                                environment.instance,
                                { action: "stop" },
                                terminal.ctxId,
                            );
                        });
                    }
                }
                if (gateway.listWaits !== undefined) {
                    const waits = await gateway
                        .listWaits(environment.instance)
                        .catch((error) => {
                            failures.push(error);
                            return [];
                        });
                    for (const wait of waits) {
                        if (wait.createdByCtxId !== terminal.ctxId) continue;
                        if (
                            (wait.status === "waiting" ||
                                wait.status === "detached") &&
                            gateway.cancelWait !== undefined
                        ) {
                            await cleanup(async () => {
                                await gateway.cancelWait!(
                                    environment.instance,
                                    wait.waitId,
                                );
                            });
                        } else if (
                            wait.status === "resolved" &&
                            gateway.consumeWait !== undefined
                        ) {
                            await cleanup(async () => {
                                await gateway.consumeWait!(
                                    environment.instance,
                                    wait.waitId,
                                );
                            });
                        }
                    }
                }
                if (gateway.contextTerminated !== undefined) {
                    await cleanup(async () => {
                        await gateway.contextTerminated!(
                            environment.instance,
                            terminal.ctxId,
                            terminalReason,
                        );
                    });
                }
                if (gateway.approval !== undefined) {
                    const approvals = await gateway.approval
                        .listApprovals(environment.instance)
                        .catch((error) => {
                            failures.push(error);
                            return [];
                        });
                    for (const approval of approvals) {
                        if (
                            approval.ctxId !== terminal.ctxId ||
                            approval.status !== "pending"
                        ) {
                            continue;
                        }
                        if (gateway.approval.cancelApproval !== undefined) {
                            await cleanup(async () => {
                                await gateway.approval!.cancelApproval!(
                                    environment.instance,
                                    approval.approvalId,
                                    "Context " +
                                        terminal.ctxId +
                                        " was " +
                                        terminalReason +
                                        ".",
                                );
                            });
                        } else if (
                            gateway.approval.decideApproval !== undefined
                        ) {
                            await cleanup(async () => {
                                await gateway.approval!.decideApproval!(
                                    environment.instance,
                                    approval.approvalId,
                                    "deny",
                                );
                            });
                        }
                    }
                }
            }

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
        const gateway =
            retirement === undefined
                ? this.#gateway(cleanup.instance)
                : undefined;
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
            if (gateway?.releaseInstanceReference === undefined)
                throw new Error(
                    `Instance ${cleanup.instance} is unavailable for Context reference cleanup.`,
                );
            await gateway.releaseInstanceReference(cleanup.instance, ctxId);
            return true;
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
        if (gateway !== undefined) {
            await gateway.releaseAlerts(cleanup.instance, cleanup.workspace);
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
