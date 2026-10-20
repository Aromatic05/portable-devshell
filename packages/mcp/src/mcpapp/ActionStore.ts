import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpAppActionEffect, McpAppResolvedAction } from "./model/Contract.js";

export type McpAppActionReceiptStatus = "prepared" | "applied" | "claiming" | "attempting" | "attempted" | "reporting" | "settled" | "suppressed" | "conflicted";

export interface McpAppActionReceipt {
    actionId: string;
    ctxId: string;
    instance: string;
    resolved: McpAppResolvedAction;
    /** Actual ToolCall after inbound Rewrite; resolved remains the original UI intent. */
    execution?: { callId: string; instance: string; toolName: string; itemId?: string; actionId?: string };
    status: McpAppActionReceiptStatus;
    effect?: McpAppActionEffect;
    claimId?: string;
    /** Persisted before Instance attempt dispatch; owner loss must not replay it. */
    attemptStarted?: true;
    outcome?: "accepted" | "rejected" | "uncertain";
    updatedAt: string;
}

interface McpAppActionDocument {
    version: 1;
    receipts: McpAppActionReceipt[];
}

export interface McpAppActionStoreOptions {
    filePath?: string;
    now?: () => number;
}

export class McpAppActionStore {
    readonly #filePath?: string;
    readonly #now: () => number;
    readonly #receipts = new Map<string, McpAppActionReceipt>();
    #initialized: boolean;
    #operation: Promise<void> = Promise.resolve();
    readonly #deliveries = new Map<string, Promise<void>>();

    constructor(options: McpAppActionStoreOptions = {}) {
        this.#filePath = options.filePath;
        this.#now = options.now ?? Date.now;
        this.#initialized = this.#filePath === undefined;
    }

    async initialize(): Promise<void> {
        await this.#run(async () => {
            if (this.#initialized) return;
            let source: string;
            try {
                source = await readFile(this.#filePath!, "utf8");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    this.#initialized = true;
                    return;
                }
                throw error;
            }
            const document: unknown = JSON.parse(source);
            if (!isDocument(document)) throw new Error(`Invalid McpApp action store: ${this.#filePath}`);
            for (const receipt of document.receipts) this.#receipts.set(receipt.actionId, receipt);
            this.#initialized = true;
        });
    }

    async get(actionId: string): Promise<McpAppActionReceipt | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const receipt = this.#receipts.get(actionId);
            return receipt === undefined ? undefined : structuredClone(receipt);
        });
    }

    async prepare(ctxId: string, instance: string, resolved: McpAppResolvedAction): Promise<McpAppActionReceipt> {
        return (await this.#change(resolved.actionId, (current) => {
            if (current !== undefined) return current;
            return this.#record({ actionId: resolved.actionId, ctxId, instance, resolved, status: "prepared" });
        }))!;
    }

    /** Reserve a receipt once across all endpoints sharing this store. */
    async prepareOnce(ctxId: string, instance: string, resolved: McpAppResolvedAction): Promise<{ receipt: McpAppActionReceipt; created: boolean }> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const previous = this.#receipts.get(resolved.actionId);
            if (previous !== undefined) return { receipt: structuredClone(previous), created: false };
            const receipt = this.#record({ actionId: resolved.actionId, ctxId, instance, resolved, status: "prepared" });
            this.#receipts.set(resolved.actionId, receipt);
            try { await this.#persist(); }
            catch (error) { this.#receipts.delete(resolved.actionId); throw error; }
            return { receipt: structuredClone(receipt), created: true };
        });
    }

    async apply(actionId: string, effect?: McpAppActionEffect, execution?: McpAppActionReceipt["execution"]): Promise<McpAppActionReceipt> {
        return (await this.#change(actionId, (current) => {
            if (current === undefined) throw new Error("McpApp action receipt is missing.");
            if (current.status !== "prepared") return current;
            return this.#record({ ...current, status: "applied", ...(effect === undefined ? {} : { effect }),
                ...(execution === undefined ? {} : { execution }) });
        }))!;
    }

    async conflict(actionId: string, execution?: McpAppActionReceipt["execution"]): Promise<void> {
        await this.#change(actionId, (current) => {
            if (current === undefined || current.status !== "prepared") throw new Error("McpApp action receipt is not prepared.");
            return this.#record({ ...current, status: "conflicted", ...(execution === undefined ? {} : { execution }) });
        });
    }

    /** Serialize the Instance round trip as well as the receipt transitions. */
    async withDelivery<T>(actionId: string, operation: (queued: boolean) => Promise<T>): Promise<T> {
        const previous = this.#deliveries.get(actionId);
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        this.#deliveries.set(actionId, pending);
        await previous;
        try { return await operation(previous !== undefined); }
        finally {
            release();
            if (this.#deliveries.get(actionId) === pending) this.#deliveries.delete(actionId);
        }
    }

    async beginDelivery(actionId: string, claimId: string): Promise<McpAppActionReceipt | undefined> {
        return await this.#transition(actionId, (current) => {
            if (current.status !== "applied" || current.effect === undefined) return undefined;
            return this.#record({ ...current, status: "claiming", claimId });
        });
    }

    /** Transfer ownership only after the Instance has admitted this claimant. */
    async confirmDelivery(actionId: string, previousClaimId: string, claimId: string): Promise<McpAppActionReceipt | undefined> {
        return await this.#transition(actionId, (current) => {
            if (current.claimId !== previousClaimId || current.attemptStarted ||
                (current.status !== "claiming" && current.status !== "attempting")) return undefined;
            return this.#record({ ...current, status: "attempting", claimId });
        });
    }

    async beginAttempt(actionId: string, claimId: string): Promise<McpAppActionReceipt | undefined> {
        return await this.#transition(actionId, (current) => {
            if (current.claimId !== claimId || current.status !== "attempting") return undefined;
            if (current.attemptStarted) return current;
            return this.#record({ ...current, attemptStarted: true });
        });
    }

    async markAttempted(actionId: string, claimId: string): Promise<McpAppActionReceipt | undefined> {
        return await this.#transition(actionId, (current) => {
            if (current.claimId !== claimId || current.status !== "attempting" || !current.attemptStarted) return undefined;
            return this.#record({ ...current, status: "attempted" });
        });
    }

    /** Only an explicit Instance refusal can undo the attempt dispatch fence. */
    async cancelAttempt(actionId: string, claimId: string): Promise<McpAppActionReceipt | undefined> {
        return await this.#transition(actionId, (current) => {
            if (current.claimId !== claimId || current.status !== "attempting" || !current.attemptStarted) return undefined;
            const { attemptStarted: _attemptStarted, ...unattempted } = current;
            return this.#record(unattempted);
        });
    }

    async beginReport(actionId: string, claimId: string, outcome: "accepted" | "rejected" | "uncertain"): Promise<McpAppActionReceipt | undefined> {
        return await this.#transition(actionId, (current) => {
            if (current.claimId !== claimId) return undefined;
            if (current.status === "reporting" && current.outcome === outcome) return current;
            if (current.status !== "attempted" &&
                !(current.status === "settled" && current.outcome === "uncertain" && outcome !== "uncertain")) return undefined;
            return this.#record({ ...current, status: "reporting", outcome });
        });
    }

    async restoreDelivery(actionId: string, claimId: string): Promise<boolean> {
        return (await this.#transition(actionId, (current) => {
            if (current.claimId !== claimId || current.attemptStarted ||
                (current.status !== "claiming" && current.status !== "attempting")) return undefined;
            const { outcome: _outcome, claimId: _claimId, ...applied } = current;
            return this.#record({ ...applied, status: "applied" });
        })) !== undefined;
    }

    async settle(actionId: string, claimId: string, outcome: "accepted" | "rejected" | "uncertain"): Promise<McpAppActionReceipt | undefined> {
        return await this.#transition(actionId, (current) => {
            if (current.claimId !== claimId || current.outcome !== outcome) return undefined;
            if (current.status === "settled") return current;
            if (current.status !== "reporting") return undefined;
            return this.#record({ ...current, status: "settled" });
        });
    }

    async suppressContextPending(ctxId: string): Promise<void> {
        await this.#suppress((receipt) => receipt.ctxId === ctxId);
    }

    async #suppress(matches: (receipt: McpAppActionReceipt) => boolean): Promise<void> {
        await this.#run(async () => {
            this.#assertInitialized();
            const previous = new Map(this.#receipts);
            let changed = false;
            for (const [id, receipt] of this.#receipts) {
                if (matches(receipt) && receipt.status === "applied" && receipt.effect !== undefined) {
                    this.#receipts.set(id, this.#record({ ...receipt, status: "suppressed" }));
                    changed = true;
                }
            }
            if (!changed) return;
            try {
                await this.#persist();
            } catch (error) {
                this.#receipts.clear();
                for (const [id, receipt] of previous) this.#receipts.set(id, receipt);
                throw error;
            }
        });
    }

    async pendingDirectives(ctxId: string, instance: string): Promise<McpAppActionEffect[]> {
        return await this.#run(async () => [...this.#receipts.values()]
            .filter((receipt) => receipt.ctxId === ctxId && receipt.instance === instance && receipt.effect !== undefined &&
                (receipt.status === "applied" || (!receipt.attemptStarted &&
                    (receipt.status === "claiming" || receipt.status === "attempting"))))
            .map((receipt) => structuredClone(receipt.effect!)));
    }

    async contextIds(): Promise<string[]> {
        return await this.#run(async () => {
            this.#assertInitialized();
            return [...new Set([...this.#receipts.values()].map((receipt) => receipt.ctxId))];
        });
    }

    async revokeContext(ctxId: string): Promise<void> {
        await this.#revoke((receipt) => receipt.ctxId === ctxId);
    }

    async revokeInstance(instance: string): Promise<void> {
        await this.#revoke((receipt) => receipt.instance === instance);
    }

    async #revoke(matches: (receipt: McpAppActionReceipt) => boolean): Promise<void> {
        await this.#run(async () => {
            this.#assertInitialized();
            const previous = new Map(this.#receipts);
            let changed = false;
            for (const [id, receipt] of this.#receipts) if (matches(receipt)) {
                this.#receipts.delete(id);
                changed = true;
            }
            if (!changed) return;
            try {
                await this.#persist();
            } catch (error) {
                this.#receipts.clear();
                for (const [id, receipt] of previous) this.#receipts.set(id, receipt);
                throw error;
            }
        });
    }

    /** A failed precondition must neither return a receipt nor rewrite storage. */
    async #transition(actionId: string, update: (current: McpAppActionReceipt) => McpAppActionReceipt | undefined): Promise<McpAppActionReceipt | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const current = this.#receipts.get(actionId);
            if (current === undefined) return undefined;
            const next = update(current);
            if (next === undefined) return undefined;
            if (next === current) return structuredClone(current);
            this.#receipts.set(actionId, next);
            try { await this.#persist(); }
            catch (error) { this.#receipts.set(actionId, current); throw error; }
            return structuredClone(next);
        });
    }

    async #change(actionId: string, update: (current: McpAppActionReceipt | undefined) => McpAppActionReceipt | undefined): Promise<McpAppActionReceipt | undefined> {
        return await this.#run(async () => {
            this.#assertInitialized();
            const before = this.#receipts.get(actionId);
            const after = update(before === undefined ? undefined : structuredClone(before));
            if (after === undefined) return before === undefined ? undefined : structuredClone(before);
            this.#receipts.set(actionId, after);
            try {
                await this.#persist();
            } catch (error) {
                if (before === undefined) this.#receipts.delete(actionId);
                else this.#receipts.set(actionId, before);
                throw error;
            }
            return structuredClone(after);
        });
    }

    #record(receipt: Omit<McpAppActionReceipt, "updatedAt">): McpAppActionReceipt {
        return { ...receipt, updatedAt: new Date(this.#now()).toISOString() };
    }

    async #persist(): Promise<void> {
        if (this.#filePath === undefined) return;
        await mkdir(dirname(this.#filePath), { recursive: true });
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ version: 1, receipts: [...this.#receipts.values()] } satisfies McpAppActionDocument, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.#filePath);
    }

    async #run<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;
        this.#operation = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await operation(); } finally { release(); }
    }

    #assertInitialized(): void {
        if (!this.#initialized) throw new Error("McpApp action store is not initialized.");
    }
}

function isDocument(value: unknown): value is McpAppActionDocument {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return record.version === 1 && Array.isArray(record.receipts) && record.receipts.every((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const receipt = entry as Record<string, unknown>;
        return (receipt.attemptStarted === undefined || receipt.attemptStarted === true) && (receipt.claimId === undefined || (typeof receipt.claimId === "string" && receipt.claimId.length > 0 && receipt.claimId.length <= 128)) && typeof receipt.actionId === "string" && typeof receipt.ctxId === "string" && typeof receipt.instance === "string" && typeof receipt.resolved === "object" && typeof receipt.status === "string";
    });
}
