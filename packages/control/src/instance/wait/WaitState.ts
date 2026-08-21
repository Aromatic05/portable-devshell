import { randomUUID } from "node:crypto";

import type {
    JsonValue,
    WaitCreateInput,
    WaitKind,
    WaitRecord,
    WaitStatus,
} from "@portable-devshell/shared";

const MAX_TERMINAL_WAITS = 1_000;
const RECOVERY_CLAIM_TTL_MS = 5 * 60_000;

export interface WaitDocument {
    version: 1;
    waits: WaitRecord[];
}

export interface WaitTransition {
    document: WaitDocument;
    record: WaitRecord;
}

export class WaitState {
    readonly #now: () => string;
    readonly #waitId: () => string;

    constructor(options: { now?: () => string; waitId?: () => string } = {}) {
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#waitId = options.waitId ?? (() => `wait-${randomUUID()}`);
    }

    emptyDocument(): WaitDocument {
        return { version: 1, waits: [] };
    }

    normalizeDocument(value: unknown): WaitDocument {
        if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.waits)) {
            throw new Error("wait document must be version 1");
        }
        return { version: 1, waits: value.waits.map(normalizeRecord) };
    }

    create(document: WaitDocument, input: WaitCreateInput): WaitTransition {
        const now = this.#now();
        const record: WaitRecord = {
            createdAt: now,
            createdByCtxId: text(input.createdByCtxId, "createdByCtxId"),
            ...(input.deadlineAt === undefined ? {} : { deadlineAt: storedText(input.deadlineAt, "deadlineAt") }),
            ...(input.goalId === undefined ? {} : { goalId: text(input.goalId, "goalId") }),
            kind: kind(input.kind),
            ...(input.ownerCallId === undefined ? {} : { ownerCallId: text(input.ownerCallId, "ownerCallId") }),
            ...(input.payload === undefined ? {} : { payload: structuredClone(input.payload) }),
            status: "waiting",
            targetId: text(input.targetId, "targetId"),
            ...(input.taskId === undefined ? {} : { taskId: text(input.taskId, "taskId") }),
            updatedAt: now,
            waitId: this.#waitId(),
        };
        return {
            document: this.compact({ ...document, waits: [...document.waits, record] }),
            record,
        };
    }

    detach(document: WaitDocument, waitId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status === "detached") return record;
            if (record.status !== "waiting") throw invalidTransition(record, "detach");
            const now = this.#now();
            return { ...record, detachedAt: now, status: "detached", updatedAt: now };
        });
    }

    reattach(document: WaitDocument, waitId: string, ownerCallId?: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "detached") throw invalidTransition(record, "reattach");
            const { detachedAt: _detachedAt, ownerCallId: _ownerCallId, ...rest } = record;
            const now = this.#now();
            return {
                ...rest,
                ...(ownerCallId === undefined ? {} : { ownerCallId }),
                status: "waiting",
                updatedAt: now,
            };
        });
    }

    resolve(document: WaitDocument, waitId: string, result?: JsonValue): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "waiting" && record.status !== "detached") {
                throw invalidTransition(record, "resolve");
            }
            const now = this.#now();
            return {
                ...record,
                ...(result === undefined ? {} : { result: structuredClone(result) }),
                resolvedAt: now,
                status: "resolved",
                updatedAt: now,
            };
        });
    }

    claimRecovery(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.detachedAt === undefined) {
                throw invalidTransition(record, "claim recovery for");
            }
            const normalizedClaimId = text(claimId, "recoveryClaimId");
            if (record.recoveryClaimId === normalizedClaimId) return record;
            const now = this.#now();
            const claimedAt = record.recoveryClaimedAt === undefined ? Number.NaN : Date.parse(record.recoveryClaimedAt);
            if (
                record.recoveryClaimId !== undefined && Number.isFinite(claimedAt) &&
                Date.parse(now) - claimedAt < RECOVERY_CLAIM_TTL_MS
            ) {
                throw new Error(`Wait ${waitId} recovery is already claimed.`);
            }
            return {
                ...record,
                recoveryClaimedAt: now,
                recoveryClaimId: normalizedClaimId,
                ...(record.recoveryMessageId === undefined
                    ? { recoveryMessageId: `recovery-message-${randomUUID()}` }
                    : {}),
                updatedAt: now,
            };
        });
    }

    markRecoverySent(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            if (record.recoveryMessageSentAt !== undefined) return record;
            const now = this.#now();
            return { ...record, recoveryMessageSentAt: now, updatedAt: now };
        });
    }

    releaseRecovery(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            const { recoveryClaimedAt: _claimedAt, recoveryClaimId: _claimId, ...rest } = record;
            const now = this.#now();
            return { ...rest, updatedAt: now };
        });
    }

    completeRecovery(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            const { recoveryClaimedAt: _claimedAt, recoveryClaimId: _claimId, ...rest } = record;
            const now = this.#now();
            return { ...rest, consumedAt: now, status: "consumed", updatedAt: now };
        });
    }

    consume(document: WaitDocument, waitId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved") throw invalidTransition(record, "consume");
            const { recoveryClaimedAt: _claimedAt, recoveryClaimId: _claimId, ...rest } = record;
            const now = this.#now();
            return { ...rest, consumedAt: now, status: "consumed", updatedAt: now };
        });
    }

    cancel(document: WaitDocument, waitId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "waiting" && record.status !== "detached") {
                throw invalidTransition(record, "cancel");
            }
            const now = this.#now();
            return { ...record, cancelledAt: now, status: "cancelled", updatedAt: now };
        });
    }

    compact(document: WaitDocument, maxTerminalWaits = MAX_TERMINAL_WAITS): WaitDocument {
        const active = document.waits.filter((record) => !isTerminal(record.status));
        const terminal = document.waits
            .filter((record) => isTerminal(record.status))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, Math.max(0, maxTerminalWaits));
        return {
            version: 1,
            waits: [...active, ...terminal].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        };
    }

    #update(
        document: WaitDocument,
        waitId: string,
        update: (record: WaitRecord) => WaitRecord,
    ): WaitTransition {
        const index = document.waits.findIndex((record) => record.waitId === waitId);
        if (index === -1) throw new Error(`Wait ${waitId} was not found.`);
        const record = update(document.waits[index]!);
        const waits = [...document.waits];
        waits[index] = record;
        return { document: this.compact({ ...document, waits }), record };
    }
}

function normalizeRecord(value: unknown): WaitRecord {
    if (!isRecord(value)) throw new Error("wait record must be an object");
    const status = waitStatus(value.status);
    return {
        ...(typeof value.cancelledAt === "string" ? { cancelledAt: value.cancelledAt } : {}),
        ...(typeof value.consumedAt === "string" ? { consumedAt: value.consumedAt } : {}),
        createdAt: storedText(value.createdAt, "createdAt"),
        createdByCtxId: storedText(value.createdByCtxId, "createdByCtxId"),
        ...(typeof value.deadlineAt === "string" ? { deadlineAt: storedText(value.deadlineAt, "deadlineAt") } : {}),
        ...(typeof value.detachedAt === "string" ? { detachedAt: value.detachedAt } : {}),
        ...(typeof value.goalId === "string" ? { goalId: storedText(value.goalId, "goalId") } : {}),
        kind: kind(value.kind),
        ...(typeof value.ownerCallId === "string" ? { ownerCallId: value.ownerCallId } : {}),
        ...("payload" in value ? { payload: value.payload as JsonValue } : {}),
        ...(typeof value.recoveryClaimedAt === "string" ? { recoveryClaimedAt: value.recoveryClaimedAt } : {}),
        ...(typeof value.recoveryClaimId === "string" ? { recoveryClaimId: value.recoveryClaimId } : {}),
        ...(typeof value.recoveryMessageId === "string" ? { recoveryMessageId: value.recoveryMessageId } : {}),
        ...(typeof value.recoveryMessageSentAt === "string" ? { recoveryMessageSentAt: value.recoveryMessageSentAt } : {}),
        ...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
        ...("result" in value ? { result: value.result as JsonValue } : {}),
        status,
        targetId: storedText(value.targetId, "targetId"),
        ...(typeof value.taskId === "string" ? { taskId: storedText(value.taskId, "taskId") } : {}),
        updatedAt: storedText(value.updatedAt, "updatedAt"),
        waitId: storedText(value.waitId, "waitId"),
    };
}

function isTerminal(status: WaitStatus): boolean {
    return status === "consumed" || status === "cancelled";
}

function kind(value: unknown): WaitKind {
    if (value === "approval" || value === "question" || value === "tmux") return value;
    throw new Error("invalid wait kind");
}

function waitStatus(value: unknown): WaitStatus {
    if (
        value === "waiting" || value === "detached" || value === "resolved" ||
        value === "consumed" || value === "cancelled"
    ) return value;
    throw new Error("invalid wait status");
}

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function storedText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`wait ${field} is invalid`);
    return value;
}

function invalidTransition(record: WaitRecord, action: string): Error {
    return new Error(`Cannot ${action} wait ${record.waitId} while it is ${record.status}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
