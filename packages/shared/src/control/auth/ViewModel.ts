// Stateful auth projection. Owns the current auth-service status and OAuth2
// approval queue. Approvals are read only while OAuth2 is active
// (`authMode === "oauth2"`, `oauthReady`, and `running`) and cleared otherwise.
// Polling is owned here (start/stop), with a 1s default cadence.
//
// Decisions are optimistic: the decided id is recorded and filtered out of any
// list response until the server reports it as no longer pending, so a stale
// in-flight list cannot resurrect an already-decided approval.

import type {
    AuthStatus,
    OAuthApprovalDecision,
    OAuthApprovalRequest,
} from "./Model.js";
import type { AuthTransport } from "./Transport.js";

interface AuthViewModelState {
    /** Failure of the most recent approval read or decision, if any. */
    approvalFailure?: Error;
    approvals: OAuthApprovalRequest[];
    /** Failure of the most recent status read, if any. */
    failure?: Error;
    status?: AuthStatus;
}

interface AuthViewModelOptions {
    /** Poll cadence in milliseconds; values <= 0 disable polling. */
    pollIntervalMs?: number;
}

export class AuthViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: AuthTransport;
    readonly #pollIntervalMs: number;
    readonly #decidedApprovals = new Set<string>();
    #approvalVersion = 0;
    #generation = 0;
    #pollTimer?: ReturnType<typeof setInterval>;
    #published: AuthViewModelState = emptyState();
    #refresh?: Promise<void>;
    #refreshRequested = false;
    #state: AuthViewModelState = emptyState();
    #statusVersion = 0;

    constructor(transport: AuthTransport, options: AuthViewModelOptions = {}) {
        this.#transport = transport;
        this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    }

    get state(): Readonly<AuthViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Reads the status and the gated approval list once. */
    async load(): Promise<void> {
        this.#generation += 1;
        await this.refresh();
    }

    refresh(): Promise<void> {
        if (this.#refresh !== undefined) {
            this.#refreshRequested = true;
            return this.#refresh;
        }
        const generation = this.#generation;
        const pending = this.#runRefreshLoop(generation).finally(() => {
            if (this.#refresh === pending) this.#refresh = undefined;
        });
        this.#refresh = pending;
        return pending;
    }

    async #runRefreshLoop(generation: number): Promise<void> {
        do {
            this.#refreshRequested = false;
            await this.#refreshOnce(generation);
        } while (this.#refreshRequested && generation === this.#generation);
    }

    async #refreshOnce(generation: number): Promise<void> {
        const applied = await this.#refreshStatus(generation);
        if (!applied) return;
        if (!this.#oauthActive()) {
            this.#clearApprovals();
            return;
        }
        await this.#refreshApprovals(generation);
    }

    start(): void {
        if (this.#pollTimer !== undefined || this.#pollIntervalMs <= 0) return;
        this.#pollTimer = setInterval(() => {
            void this.refresh().catch(() => undefined);
        }, this.#pollIntervalMs);
    }

    stop(): void {
        if (this.#pollTimer === undefined) return;
        clearInterval(this.#pollTimer);
        this.#pollTimer = undefined;
    }

    async decideApproval(
        approvalId: string,
        decision: OAuthApprovalDecision,
    ): Promise<OAuthApprovalRequest> {
        const generation = this.#generation;
        this.#decidedApprovals.add(approvalId);
        this.#removeApproval(approvalId);
        try {
            const decided = await this.#transport.decideApproval(
                approvalId,
                decision,
            );
            if (generation === this.#generation) await this.refresh();
            return decided;
        } catch (error) {
            if (generation === this.#generation) {
                this.#decidedApprovals.delete(approvalId);
                this.#state = {
                    ...this.#state,
                    approvalFailure: toError(error),
                };
                this.#emit();
                await this.refresh();
            }
            throw error;
        }
    }

    close(): void {
        this.stop();
        this.#generation += 1;
        this.#refreshRequested = false;
        this.#decidedApprovals.clear();
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    async #refreshStatus(generation: number): Promise<boolean> {
        const version = ++this.#statusVersion;
        try {
            const status = await this.#transport.status();
            if (!this.#statusCurrent(generation, version)) return false;
            this.#state = {
                ...this.#state,
                failure: undefined,
                status,
            };
            this.#emit();
            return true;
        } catch (error) {
            if (!this.#statusCurrent(generation, version)) return false;
            this.#state = { ...this.#state, failure: toError(error) };
            this.#emit();
            return false;
        }
    }

    async #refreshApprovals(generation: number): Promise<void> {
        const version = ++this.#approvalVersion;
        try {
            const approvals = await this.#transport.listApprovals();
            if (!this.#approvalCurrent(generation, version)) return;
            this.#applyApprovals(approvals);
        } catch (error) {
            if (!this.#approvalCurrent(generation, version)) return;
            this.#state = {
                ...this.#state,
                approvalFailure: toError(error),
            };
            this.#emit();
        }
    }

    #applyApprovals(approvals: OAuthApprovalRequest[]): void {
        for (const id of [...this.#decidedApprovals]) {
            const current = approvals.find(
                (approval) => approval.approvalId === id,
            );
            if (current === undefined || current.status !== "pending")
                this.#decidedApprovals.delete(id);
        }
        this.#state = {
            ...this.#state,
            approvalFailure: undefined,
            approvals: approvals.filter(
                (approval) =>
                    approval.status !== "pending" ||
                    !this.#decidedApprovals.has(approval.approvalId),
            ),
        };
        this.#emit();
    }

    #clearApprovals(): void {
        this.#approvalVersion += 1;
        if (
            this.#state.approvals.length === 0 &&
            this.#state.approvalFailure === undefined
        )
            return;
        this.#state = {
            ...this.#state,
            approvalFailure: undefined,
            approvals: [],
        };
        this.#emit();
    }

    #removeApproval(approvalId: string): void {
        if (
            !this.#state.approvals.some(
                (approval) => approval.approvalId === approvalId,
            )
        )
            return;
        this.#state = {
            ...this.#state,
            approvals: this.#state.approvals.filter(
                (approval) => approval.approvalId !== approvalId,
            ),
        };
        this.#emit();
    }

    #oauthActive(): boolean {
        const status = this.#state.status;
        return (
            status?.authMode === "oauth2" &&
            status.oauthReady === true &&
            status.running === true
        );
    }

    #statusCurrent(generation: number, version: number): boolean {
        return (
            generation === this.#generation && version === this.#statusVersion
        );
    }

    #approvalCurrent(generation: number, version: number): boolean {
        return (
            generation === this.#generation && version === this.#approvalVersion
        );
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): AuthViewModelState {
    return { approvals: [] };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
