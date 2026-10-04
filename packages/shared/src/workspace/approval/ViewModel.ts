// Stateful approval projection. Owns the pending approval list and a dedicated
// approval event subscription. Decisions are applied optimistically (mirroring
// the existing UI) and then reconciled by an authoritative re-read; gap recovery
// re-reads and resumes from lastSeq + 1.

import {
    type ApprovalEvent,
    type ApprovalDecisionOptions,
    type ApprovalDecisionValue,
    type ApprovalRequest,
} from "./Model.js";
import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../client/Stream.js";
import type { ApprovalTransport } from "./Transport.js";

export interface ApprovalViewModelState {
    approvals: ApprovalRequest[];
    failure?: Error;
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
}

export class ApprovalViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: ApprovalTransport;
    #generation = 0;
    #instance?: string;
    #published: ApprovalViewModelState = emptyState();
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: ApprovalViewModelState = emptyState();
    #subscription?: InstanceEventSubscription<ApprovalEvent>;

    constructor(transport: ApprovalTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<ApprovalViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async load(instance: string): Promise<void> {
        this.#instance = instance;
        const generation = ++this.#generation;
        const result = await this.#transport.snapshot(instance, {
            pendingOnly: true,
        });
        if (generation !== this.#generation) return;
        this.#apply(result.approvals, result.lastSeq);
        this.#ensureSubscription(result.lastSeq + 1);
    }

    async refresh(): Promise<void> {
        if (this.#instance === undefined) return;
        const instance = this.#instance;
        const generation = this.#generation;
        const result = await this.#transport.snapshot(instance, {
            pendingOnly: true,
        });
        if (generation !== this.#generation) return;
        this.#apply(result.approvals, result.lastSeq);
    }

    async decide(
        approvalId: string,
        decision: ApprovalDecisionValue,
        options?: ApprovalDecisionOptions,
    ): Promise<ApprovalRequest> {
        const instance = this.#requireInstance();
        const generation = this.#generation;
        this.#remove(approvalId);
        try {
            const decided = await this.#transport.decide(
                instance,
                approvalId,
                decision,
                options,
            );
            if (generation === this.#generation)
                void this.refresh().catch(() => undefined);
            return decided;
        } catch (error) {
            if (generation === this.#generation) {
                this.#state = { ...this.#state, failure: toError(error) };
                this.#emit();
                void this.refresh().catch(() => undefined);
            }
            throw error;
        }
    }

    get(approvalId: string): Promise<ApprovalRequest> {
        return this.#transport.get(this.#requireInstance(), approvalId);
    }

    close(): void {
        this.#generation += 1;
        this.#instance = undefined;
        if (this.#refreshTimer !== undefined) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = undefined;
        }
        this.#subscription?.stop();
        this.#subscription = undefined;
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    #ensureSubscription(fromSeq: number): void {
        if (this.#subscription !== undefined) return;
        const instance = this.#requireInstance();
        this.#subscription = new InstanceEventSubscription<ApprovalEvent>(
            fromSeq,
            {
                onEvent: () => this.#scheduleRefresh(),
                onGap: () => this.#recover(),
                onStatusChange: (status) => {
                    this.#state = { ...this.#state, status };
                    this.#emit();
                },
                open: (cursor) => this.#transport.subscribe(instance, cursor),
            },
        );
        this.#subscription.start();
    }

    #scheduleRefresh(): void {
        if (this.#refreshTimer !== undefined) return;
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            void this.refresh().catch(() => undefined);
        }, 100);
    }

    async #recover(): Promise<number | undefined> {
        try {
            const instance = this.#requireInstance();
            const result = await this.#transport.snapshot(instance, {
                pendingOnly: true,
            });
            this.#apply(result.approvals, result.lastSeq);
            return result.lastSeq + 1;
        } catch {
            return undefined;
        }
    }

    #remove(approvalId: string): void {
        this.#state = {
            ...this.#state,
            approvals: this.#state.approvals.filter(
                (approval) => approval.approvalId !== approvalId,
            ),
        };
        this.#emit();
    }

    #apply(approvals: ApprovalRequest[], sequence: number): void {
        this.#state = {
            approvals: approvals.filter(
                (approval) => approval.status === "pending",
            ),
            failure: undefined,
            lastSeq: sequence,
            status: this.#state.status,
        };
        this.#emit();
    }

    #requireInstance(): string {
        if (this.#instance === undefined)
            throw new Error("Approval view model is not loaded.");
        return this.#instance;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): ApprovalViewModelState {
    return { approvals: [], lastSeq: 0, status: "stopped" };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
