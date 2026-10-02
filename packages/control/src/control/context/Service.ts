import { isMcpGoalGateway, type McpInstanceGateway, type WorkerInstanceLike } from "@portable-devshell/mcp";
import type { ContextRegistryPort, McpContextQuery, McpContextRecord } from "@portable-devshell/shared";
import type { ContextEnvironmentPort, ContextCleanupPort } from "@portable-devshell/mcp";

export interface ContextPresentationPort {
    revokeContext(ctxId: string): Promise<void>;
    revokeInstance(instance: string): Promise<void>;
}

export class ContextService {
    readonly registry: ContextRegistryPort;
    readonly environment: ContextEnvironmentPort;
    readonly cleanup: ContextCleanupPort;
    readonly #gateway: (instance: string) => McpInstanceGateway | undefined;
    readonly #worker: (instance: string) => WorkerInstanceLike | undefined;
    #presentation?: ContextPresentationPort;

    constructor(options: {
        registry: ContextRegistryPort;
        environment: ContextEnvironmentPort;
        cleanup: ContextCleanupPort;
        gateway(instance: string): McpInstanceGateway | undefined;
        worker(instance: string): WorkerInstanceLike | undefined;
    }) {
        this.registry = options.registry;
        this.environment = options.environment;
        this.cleanup = options.cleanup;
        this.#gateway = options.gateway;
        this.#worker = options.worker;
    }

    bindPresentation(presentation: ContextPresentationPort): void {
        this.#presentation = presentation;
    }

    async initialize(): Promise<void> {
        await this.registry.initialize();
    }

    async reconcile(): Promise<void> {
        for (const context of await this.registry.listCleanupPending()) {
            await this.#cleanupTerminalContext(context);
        }
        await this.cleanup.reconcile();
    }

    async list(query: McpContextQuery = {}): Promise<McpContextRecord[]> {
        return await this.registry.list(query);
    }

    async disable(ctxId: string): Promise<McpContextRecord> {
        const record = await this.registry.disable(ctxId);
        await this.#cleanupTerminalContext(record);
        return record;
    }

    async renew(ctxId: string): Promise<McpContextRecord> {
        const record = await this.registry.renew(ctxId);
        for (const environment of record.environments) {
            if (environment.workspace === undefined) continue;
            const worker = this.#worker(environment.instance);
            if (worker?.snapshot().ready === true) {
                await worker.touchAlerts?.(environment.workspace);
            }
        }
        return record;
    }

    async referenceInstance(ctxId: string, instance: string) {
        return await this.registry.referenceInstance(ctxId, instance);
    }

    async validateForInstance(ctxId: string, instance: string): Promise<McpContextRecord> {
        return await this.registry.validateForInstance(ctxId, instance);
    }

    async detachInstance(instance: string): Promise<McpContextRecord[]> {
        const affected = await this.registry.detachInstance(instance);
        await this.#presentation?.revokeInstance(instance);
        return affected;
    }

    async #cleanupTerminalContext(terminal: McpContextRecord): Promise<void> {
        if (terminal.status === "active") {
            throw new Error(
                "Active Context " + terminal.ctxId + " cannot be terminally cleaned.",
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

        const contexts = await this.registry
            .list()
            .catch((error) => {
                failures.push(error);
                return undefined;
            });
        const now = Date.now();
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
                    if (goal?.status === "active" || goal?.status === "blocked") {
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
                    const approvals = await gateway
                        .approval.listApprovals(environment.instance)
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
                        } else if (gateway.approval.decideApproval !== undefined) {
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

            if (
                environment.workspace !== undefined &&
                contexts !== undefined
            ) {
                const workspace = environment.workspace;
                const hasOtherActiveContext = contexts.some(
                    (context) =>
                        context.ctxId !== terminal.ctxId &&
                        context.status === "active" &&
                        Date.parse(context.expiresAt) > now &&
                        context.environments.some(
                            (candidate) =>
                                candidate.instance === environment.instance &&
                                candidate.workspace === workspace,
                        ),
                );
                if (!hasOtherActiveContext) {
                    const worker = this.#worker(environment.instance);
                    const releaseAlerts = worker?.releaseAlerts;
                    if (releaseAlerts !== undefined && worker !== undefined) {
                        await cleanup(async () => {
                            await releaseAlerts.call(worker, workspace);
                        });
                    } else if (gateway !== undefined) {
                        await cleanup(async () => {
                            await gateway.releaseAlerts(
                                environment.instance,
                                workspace,
                            );
                        });
                    }
                }
            }

            {
                await cleanup(async () => {
                    await this.registry.recordEnvironmentCleanup(
                        terminal.ctxId,
                        {
                            instance: environment.instance,
                            kind: "instance_reference",
                        },
                    );
                });
            }
        }

        await cleanup(async () => {
            await this.cleanup.reconcile(
                terminal.ctxId,
            );
        });
        if (failures.length === 0) {
            await this.registry
                .settleCleanup(terminal.ctxId)
                .catch((error) => failures.push(error));
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

}
