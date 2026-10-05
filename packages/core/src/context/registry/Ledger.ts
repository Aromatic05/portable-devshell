import type {
    ContextCleanupLedgerPort,
    ContextEnvironmentCleanup,
    ContextRecord,
} from "@portable-devshell/shared";
import type { ContextStatePort } from "./Record.js";
import {
    invalidContext,
    isCtxId,
    cloneRecord,
    parseEnvironmentCleanup,
    sameEnvironmentCleanup,
    appendEnvironmentCleanup,
} from "./Record.js";

export class ContextCleanupLedger implements ContextCleanupLedgerPort {
    readonly #host: ContextStatePort;

    constructor(host: ContextStatePort) {
        this.#host = host;
    }

    async listCleanupPending(): Promise<ContextRecord[]> {
        return await this.#host.run(async () => {
            this.#host.assertInitialized();
            return [...this.#host.records.values()]
                .filter(
                    (record) =>
                        record.cleanupPending === true ||
                        (record.status === "disabled" &&
                            record.cleanupPending === undefined),
                )
                .map(cloneRecord);
        });
    }

    async listEnvironmentCleanup(
        ctxId?: string,
    ): Promise<Array<{ cleanup: ContextEnvironmentCleanup; ctxId: string }>> {
        return await this.#host.run(async () => {
            this.#host.assertInitialized();
            return [...this.#host.records.values()]
                .filter(
                    (record) => ctxId === undefined || record.ctxId === ctxId,
                )
                .flatMap((record) =>
                    (record.pendingEnvironmentCleanup ?? []).map((cleanup) => ({
                        cleanup: { ...cleanup },
                        ctxId: record.ctxId,
                    })),
                );
        });
    }

    async recordEnvironmentCleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
    ): Promise<void> {
        await this.#host.run(async () => {
            this.#host.assertInitialized();
            const record = this.#host.records.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (parseEnvironmentCleanup(cleanup) === undefined) {
                throw new Error("Invalid Context environment cleanup record.");
            }
            if (
                (record.pendingEnvironmentCleanup ?? []).some((candidate) =>
                    sameEnvironmentCleanup(candidate, cleanup),
                )
            ) {
                return;
            }
            await this.#host.mutate(() => {
                appendEnvironmentCleanup(record, cleanup);
            });
        });
    }

    async settleCleanup(ctxId: string): Promise<void> {
        await this.#host.run(async () => {
            this.#host.assertInitialized();
            const record = this.#host.records.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (record.status === "active" || record.cleanupPending === false)
                return;
            if ((record.pendingEnvironmentCleanup?.length ?? 0) > 0) {
                throw new Error(
                    `Context ${ctxId} cannot settle terminal cleanup while environment cleanup is pending.`,
                );
            }
            await this.#host.mutate(() => {
                record.cleanupPending = false;
            });
        });
    }

    async settleEnvironmentCleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
    ): Promise<void> {
        await this.#host.run(async () => {
            this.#host.assertInitialized();
            const record = this.#host.records.get(ctxId);
            if (record === undefined || !isCtxId(ctxId)) {
                throw invalidContext(ctxId);
            }
            if (
                !(record.pendingEnvironmentCleanup ?? []).some((candidate) =>
                    sameEnvironmentCleanup(candidate, cleanup),
                )
            ) {
                return;
            }
            await this.#host.mutate(() => {
                record.pendingEnvironmentCleanup =
                    record.pendingEnvironmentCleanup?.filter(
                        (candidate) =>
                            !sameEnvironmentCleanup(candidate, cleanup),
                    );
                if (record.pendingEnvironmentCleanup?.length === 0) {
                    record.pendingEnvironmentCleanup = undefined;
                }
            });
        });
    }
}
