import type { ContextMessageRecord } from "../dto/context/DtoContextMessage.js";
import type { InstanceSnapshot } from "../dto/instance/DtoInstanceSnapshot.js";
import type { OAuthApprovalDecision, OAuthApprovalRequest } from "../dto/oauth/DtoOAuthApproval.js";
import type { ApprovalDecision, ApprovalRequest } from "../dto/tool/DtoToolApproval.js";
import type { ControlReadModel } from "../read-model/ControlReadModel.js";
import type { ControlClients, RuntimeStartOptions } from "./ControlClients.js";
import { withRequestTimeout } from "./RequestTimeout.js";

export interface ControlCommandsOptions {
    clients: ControlClients;
    model: ControlReadModel;
    timeoutMs?: number;
}

export class ControlCommands {
    readonly #clients: ControlClients;
    readonly #model: ControlReadModel;
    readonly #timeoutMs: number;
    #epoch = 0;

    constructor(options: ControlCommandsOptions) {
        this.#clients = options.clients;
        this.#model = options.model;
        this.#timeoutMs = options.timeoutMs ?? 30_000;
    }

    reset(): void {
        this.#epoch += 1;
    }

    async startInstance(instance: string, options: RuntimeStartOptions = {}): Promise<InstanceSnapshot> {
        const epoch = this.#epoch;
        const snapshot = await this.#request(
            this.#clients.runtime.start(instance, options),
            `runtime.start:${instance}`,
        );
        if (this.#current(epoch, options.signal)) this.#acceptSnapshot(snapshot);
        return snapshot;
    }

    async stopInstance(instance: string): Promise<InstanceSnapshot> {
        const epoch = this.#epoch;
        const snapshot = await this.#request(
            this.#clients.runtime.stop(instance),
            `runtime.stop:${instance}`,
        );
        if (this.#current(epoch)) this.#acceptSnapshot(snapshot);
        return snapshot;
    }

    async refreshInstance(instance: string): Promise<InstanceSnapshot> {
        const epoch = this.#epoch;
        const result = await this.#request(
            this.#clients.runtime.refresh(instance),
            `runtime.refresh:${instance}`,
            "read",
        );
        if (this.#current(epoch)) this.#model.applyAuthoritativeSnapshot(result.snapshot);
        return result.snapshot;
    }

    async decideToolApproval(
        instance: string,
        approvalId: string,
        decision: ApprovalDecision["decision"],
    ): Promise<ApprovalRequest> {
        const epoch = this.#epoch;
        const decided = await this.#request(
            this.#clients.tool.decideApproval(instance, approvalId, decision),
            `approval.${decision}:${approvalId}`,
        );
        if (this.#current(epoch)) {
            this.#model.recordToolDecision(instance, decided.approvalId);
            this.#refreshInstance(instance, ["approvals", "todo", "toolCalls", "commentCalls"]);
            this.#refreshOverview();
        }
        return decided;
    }

    async decideOAuthApproval(
        approvalId: string,
        decision: OAuthApprovalDecision,
    ): Promise<OAuthApprovalRequest> {
        const epoch = this.#epoch;
        const decided = await this.#request(
            this.#clients.mcp.decideApproval(approvalId, decision),
            `oauthApproval.${decision}:${approvalId}`,
        );
        if (this.#current(epoch)) {
            this.#model.recordOAuthDecision(decided.approvalId);
            this.#background(this.#model.refreshOAuth());
            this.#refreshOverview();
        }
        return decided;
    }

    async queueContextMessage(
        instance: string,
        ctxId: string,
        text: string,
    ): Promise<ContextMessageRecord> {
        const epoch = this.#epoch;
        const queued = await this.#request(
            this.#clients.contextMessage.queue(instance, { ctxId, text }),
            `contextMessage.queue:${instance}`,
        );
        if (this.#current(epoch)) {
            this.#model.mergeQueuedContextMessage(instance, queued);
            this.#refreshInstance(instance, ["contextMessages", "commentCalls"]);
        }
        return queued;
    }

    #acceptSnapshot(snapshot: InstanceSnapshot): void {
        this.#model.applyAuthoritativeSnapshot(snapshot);
        this.#refreshInstance(snapshot.name);
        this.#refreshOverview();
    }

    #refreshInstance(
        instance: string,
        keys?: Parameters<ControlReadModel["refreshInstance"]>[1],
    ): void {
        this.#background(this.#model.refreshInstance(instance, keys));
    }

    #refreshOverview(): void {
        this.#background(this.#model.refreshOverview());
    }

    #background(request: Promise<unknown>): void {
        void request.catch(() => undefined);
    }

    #current(epoch: number, signal?: AbortSignal): boolean {
        return this.#epoch === epoch && signal?.aborted !== true;
    }

    async #request<T>(
        request: Promise<T>,
        label: string,
        outcome: "read" | "uncertain" = "uncertain",
    ): Promise<T> {
        return await withRequestTimeout(request, this.#timeoutMs, label, outcome);
    }
}
