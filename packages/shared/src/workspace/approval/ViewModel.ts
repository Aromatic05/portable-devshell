// Stateful approval projection. Owns the pending approval list and a dedicated
// approval event subscription. Decisions are applied optimistically (mirroring
// the existing UI) and then reconciled by an authoritative re-read; gap recovery
// re-reads and resumes from lastSeq + 1.

import {
    type ApprovalEvent,
    type ApprovalDecisionOptions,
    type ApprovalDecisionValue,
    type ApprovalListResult,
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
    readonly #deciding = new Set<string>();
    readonly #listeners = new Set<() => void>();
    readonly #transport: ApprovalTransport;
    #generation = 0;
    #mutation = 0;
    #readOrder = 0;
    #appliedRead = 0;
    #snapshotSeq?: number;
    #subscribeRequested = false;
    #published: ApprovalViewModelState = emptyState();
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: ApprovalViewModelState = emptyState();
    #subscription?: InstanceEventSubscription<ApprovalEvent>;
    #subscriptionGeneration?: number;

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

    async load(): Promise<void> {
        const generation = ++this.#generation;
        // A new load can belong to a restarted instance with a reset cursor.
        // Keep the rows and stream usable until its first successful snapshot,
        // but fence old reads and replace the stream from the new cursor.
        this.#snapshotSeq = undefined;
        this.#deciding.clear();
        this.#subscribeRequested = true;
        await this.#readSnapshot(generation);
    }

    async refresh(): Promise<void> {
        await this.#readSnapshot(this.#generation);
    }

    async decide(
        approvalId: string,
        decision: ApprovalDecisionValue,
        options?: ApprovalDecisionOptions,
    ): Promise<ApprovalRequest> {
        const generation = this.#generation;
        this.#mutation += 1;
        this.#deciding.add(approvalId);
        this.#remove(approvalId);
        try {
            const decided = await this.#transport.decide(
                approvalId,
                decision,
                options,
            );
            return decided;
        } catch (error) {
            if (generation === this.#generation) {
                this.#state = { ...this.#state, failure: toError(error) };
                this.#emit();
            }
            throw error;
        } finally {
            if (generation === this.#generation) {
                this.#deciding.delete(approvalId);
                // Reads captured during the decision can still show pending.
                this.#mutation += 1;
                void this.refresh().catch(() => undefined);
            }
        }
    }

    get(approvalId: string): Promise<ApprovalRequest> {
        return this.#transport.get(approvalId);
    }

    close(): void {
        this.#generation += 1;
        this.#subscribeRequested = false;
        this.#stopSubscription();
        this.#deciding.clear();
        this.#snapshotSeq = undefined;
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    #stopSubscription(): void {
        if (this.#refreshTimer !== undefined) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = undefined;
        }
        const subscription = this.#subscription;
        this.#subscription = undefined;
        this.#subscriptionGeneration = undefined;
        subscription?.stop();
    }

    #ensureSubscription(fromSeq: number, generation: number): void {
        if (generation !== this.#generation || !this.#subscribeRequested) return;
        if (this.#subscriptionGeneration === generation) return;
        this.#stopSubscription();
        const subscription: InstanceEventSubscription<ApprovalEvent> = new InstanceEventSubscription<ApprovalEvent>(
            fromSeq,
            {
                onEvent: () => {
                    if (this.#subscription === subscription) this.#scheduleRefresh();
                },
                onGap: () => this.#subscription === subscription
                    ? this.#recover(this.#generation)
                    : undefined,
                onStatusChange: (status) => {
                    if (this.#subscription !== subscription) return;
                    this.#state = { ...this.#state, status };
                    this.#emit();
                },
                open: (cursor) => this.#transport.subscribe(cursor),
            },
        );
        this.#subscription = subscription;
        this.#subscriptionGeneration = generation;
        subscription.start();
    }

    #scheduleRefresh(): void {
        if (this.#refreshTimer !== undefined) return;
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            void this.refresh().catch(() => undefined);
        }, 100);
    }

    async #recover(generation: number): Promise<number | undefined> {
        try {
            const current = await this.#readSnapshot(generation);
            if (!current || generation !== this.#generation) return undefined;
            // A concurrent refresh may have advanced beyond the recovery read.
            return this.#state.lastSeq + 1;
        } catch {
            return undefined;
        }
    }

    async #readSnapshot(generation: number): Promise<boolean> {
        if (generation !== this.#generation) return false;
        const mutation = this.#mutation;
        const order = ++this.#readOrder;
        const result = await this.#transport.snapshot({ pendingOnly: true });
        if (generation !== this.#generation || mutation !== this.#mutation)
            return false;
        this.#apply(result, order);
        this.#ensureSubscription(this.#state.lastSeq + 1, generation);
        return generation === this.#generation && mutation === this.#mutation;
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

    #apply(result: ApprovalListResult, order: number): void {
        const { approvals, lastSeq: sequence } = result;
        // Sequence wins; request order breaks ties when no event was appended.
        if (this.#snapshotSeq !== undefined && (
            sequence < this.#snapshotSeq ||
            (sequence === this.#snapshotSeq && order < this.#appliedRead)
        )) return;
        this.#snapshotSeq = sequence;
        this.#appliedRead = order;
        this.#state = {
            approvals: approvals.filter(
                (approval) => approval.status === "pending" && !this.#deciding.has(approval.approvalId),
            ),
            failure: undefined,
            lastSeq: sequence,
            status: this.#state.status,
        };
        this.#emit();
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
