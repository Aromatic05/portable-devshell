import type { McpContextEnvironmentCleanup } from "@portable-devshell/shared";
import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { McpInstanceGateway } from "../../../../mcp/src/endpoint/Port.js";

export class ContextCleanupService {
    readonly #registry: ContextRegistryPort;
    readonly #gateway: (instance: string) => McpInstanceGateway | undefined;
    readonly #releaseLocalAlerts?: (instance: string, workspace: string) => Promise<void>;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextRegistryPort;
        gateway(instance: string): McpInstanceGateway | undefined;
        releaseLocalAlerts?(instance: string, workspace: string): Promise<void>;
    }) {
        this.#registry = options.contextRegistry;
        this.#gateway = options.gateway;
        this.#releaseLocalAlerts = options.releaseLocalAlerts;
    }

    async reconcile(ctxId?: string): Promise<void> {
        const pending = await this.#registry.listEnvironmentCleanup(ctxId);
        const failures: unknown[] = [];
        for (const id of [...new Set(pending.map(({ ctxId: id }) => id))]) {
            await this.#run(id, async () => {
                for (const { cleanup } of await this.#registry.listEnvironmentCleanup(id)) {
                    try {
                        const settled = await this.#cleanup(id, cleanup);
                        if (settled) await this.#registry.settleEnvironmentCleanup(id, cleanup);
                    } catch (error) {
                        failures.push(error);
                    }
                }
            });
        }
        if (failures.length) throw new AggregateError(failures, "Context environment cleanup was incomplete.");
    }

    async #cleanup(ctxId: string, cleanup: McpContextEnvironmentCleanup): Promise<boolean> {
        const contexts = await this.#registry.list();
        const now = Date.now();
        const gateway = this.#gateway(cleanup.instance);
        if (cleanup.kind === "instance_reference") {
            if (contexts.some((context) => context.ctxId === ctxId && context.status === "active" && Date.parse(context.expiresAt) > now && context.environments.some((environment) => environment.instance === cleanup.instance))) return true;
            if (gateway?.releaseInstanceReference === undefined) throw new Error(`Instance ${cleanup.instance} is unavailable for Context reference cleanup.`);
            await gateway.releaseInstanceReference(cleanup.instance, ctxId);
            return true;
        }
        if (contexts.some((context) => context.status === "active" && Date.parse(context.expiresAt) > now && context.environments.some((environment) => environment.instance === cleanup.instance && environment.workspace === cleanup.workspace))) return false;
        if (cleanup.workspace === undefined) throw new Error("Alert cleanup requires a workspace.");
        if (gateway !== undefined) { await gateway.releaseAlerts(cleanup.instance, cleanup.workspace); return true; }
        if (this.#releaseLocalAlerts !== undefined) { await this.#releaseLocalAlerts(cleanup.instance, cleanup.workspace); return true; }
        throw new Error(`Instance ${cleanup.instance} is unavailable for alert cleanup.`);
    }

    async #run(ctxId: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.#transactions.get(ctxId) ?? Promise.resolve();
        const current = previous.then(operation, operation);
        const completion = current.then(() => undefined, () => undefined);
        this.#transactions.set(ctxId, completion);
        try { await current; } finally { if (this.#transactions.get(ctxId) === completion) this.#transactions.delete(ctxId); }
    }
}
