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
export const WAIT_RECOVERY_EXECUTION_LEASE_MS = 60_000;

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
        return this.#reconcileTmuxWaits({ version: 1, waits: value.waits.map(normalizeRecord) });
    }

    create(document: WaitDocument, input: WaitCreateInput): WaitTransition {
        if (input.kind === "tmux") {
            const existing = document.waits.find((record) =>
                blocksTmuxWaitCreation(record) && sameTmuxTarget(record, input)
            );
            if (existing !== undefined) {
                throw new Error(
                    `Tmux task ${input.targetId} already has recoverable wait ${existing.waitId} for Context ${input.createdByCtxId}.`,
                );
            }
        }
        const now = this.#now();
        const record: WaitRecord = {
            ...(input.automaticRecovery === undefined ? {} : { automaticRecovery: input.automaticRecovery }),
            createdAt: now,
            createdByCtxId: text(input.createdByCtxId, "createdByCtxId"),
            ...(input.deadlineAt === undefined ? {} : { deadlineAt: storedText(input.deadlineAt, "deadlineAt") }),
            ...(input.goalId === undefined ? {} : { goalId: text(input.goalId, "goalId") }),
            ...(input.goalProgressAt === undefined ? {} : { goalProgressAt: storedText(input.goalProgressAt, "goalProgressAt") }),
            ...(input.goalRevision === undefined ? {} : { goalRevision: positiveInteger(input.goalRevision, "goalRevision") }),
            ...(input.goalStepId === undefined ? {} : { goalStepId: text(input.goalStepId, "goalStepId") }),
            kind: kind(input.kind),
            ...(input.ownerCallId === undefined ? {} : { ownerCallId: text(input.ownerCallId, "ownerCallId") }),
            ...(input.payload === undefined ? {} : { payload: structuredClone(input.payload) }),
            status: "waiting",
            ...(input.targetInstance === undefined ? {} : { targetInstance: text(input.targetInstance, "targetInstance") }),
            targetId: text(input.targetId, "targetId"),
            ...(input.taskId === undefined ? {} : { taskId: text(input.taskId, "taskId") }),
            ...(input.taskRevision === undefined ? {} : { taskRevision: positiveInteger(input.taskRevision, "taskRevision") }),
            ...(input.todoItemId === undefined ? {} : { todoItemId: text(input.todoItemId, "todoItemId") }),
            updatedAt: now,
            waitId: this.#waitId(),
            ...(input.workspace === undefined ? {} : { workspace: text(input.workspace, "workspace") }),
        };
        return {
            document: this.compact({ ...document, waits: [...document.waits, record] }),
            record,
        };
    }

    detach(document: WaitDocument, waitId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status === "detached" || (record.status === "resolved" && record.detachedAt !== undefined)) {
                return record;
            }
            const now = this.#now();
            if (record.status === "waiting") {
                return { ...record, detachedAt: now, status: "detached", updatedAt: now };
            }
            if (record.status === "resolved") {
                return { ...record, detachedAt: now, updatedAt: now };
            }
            throw invalidTransition(record, "detach");
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
            if (record.recoveryMessageAttemptedAt !== undefined && record.recoveryMessageSentAt === undefined) {
                throw new Error(`Wait ${waitId} recovery delivery is uncertain; automatic replay is disabled.`);
            }
            if (record.recoveryDisabledAt !== undefined) {
                throw new Error(`Wait ${waitId} is not available for automatic recovery.`);
            }
            const normalizedClaimId = text(claimId, "recoveryClaimId");
            if (record.recoveryClaimId === normalizedClaimId) return record;
            const now = this.#now();
            const nowMs = Date.parse(now);

            if (record.recoveryMessageSentAt !== undefined) {
                const sentAtMs = Date.parse(record.recoveryMessageSentAt);
                const retryAtMs = record.recoveryRetryAfter === undefined
                    ? sentAtMs + WAIT_RECOVERY_EXECUTION_LEASE_MS
                    : Date.parse(record.recoveryRetryAfter);
                if (!Number.isFinite(retryAtMs) || nowMs < retryAtMs) {
                    throw new Error(`Wait ${waitId} recovery retry lease has not elapsed.`);
                }
                const {
                    recoveryClaimedAt: _claimedAt,
                    recoveryClaimId: _claimId,
                    recoveryMessageAttemptedAt: _attemptedAt,
                    recoveryMessageId: _messageId,
                    recoveryMessageSentAt: _sentAt,
                    recoveryRetryAfter: _retryAfter,
                    ...rest
                } = record;
                return {
                    ...rest,
                    recoveryClaimedAt: now,
                    recoveryClaimId: normalizedClaimId,
                    recoveryMessageId: `recovery-message-${randomUUID()}`,
                    recoveryRetryCount: (record.recoveryRetryCount ?? 0) + 1,
                    updatedAt: now,
                };
            }

            const claimedAt = record.recoveryClaimedAt === undefined ? Number.NaN : Date.parse(record.recoveryClaimedAt);
            if (
                record.recoveryClaimId !== undefined && Number.isFinite(claimedAt) &&
                nowMs - claimedAt < RECOVERY_CLAIM_TTL_MS
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
                recoveryRetryCount: record.recoveryRetryCount ?? 0,
                updatedAt: now,
            };
        });
    }

    markRecoveryAttempted(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            if (record.recoveryMessageAttemptedAt !== undefined) return record;
            const now = this.#now();
            return { ...record, recoveryMessageAttemptedAt: now, updatedAt: now };
        });
    }

    markRecoverySent(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            if (record.recoveryMessageAttemptedAt === undefined) {
                throw new Error(`Wait ${waitId} recovery was not marked attempted.`);
            }
            if (record.recoveryMessageSentAt !== undefined) return record;
            const now = this.#now();
            return {
                ...record,
                recoveryMessageSentAt: now,
                recoveryRetryAfter: new Date(Date.parse(now) + WAIT_RECOVERY_EXECUTION_LEASE_MS).toISOString(),
                recoveryRetryCount: record.recoveryRetryCount ?? 0,
                updatedAt: now,
            };
        });
    }

    releaseRecovery(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            if (record.recoveryMessageAttemptedAt !== undefined && record.recoveryMessageSentAt === undefined) {
                throw new Error(`Wait ${waitId} recovery delivery is uncertain and cannot be released automatically.`);
            }
            const { recoveryClaimedAt: _claimedAt, recoveryClaimId: _claimId, ...rest } = record;
            const now = this.#now();
            return { ...rest, updatedAt: now };
        });
    }

    rejectRecovery(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            if (record.recoveryMessageAttemptedAt === undefined || record.recoveryMessageSentAt !== undefined) {
                throw new Error(`Wait ${waitId} recovery is not a rejectable attempted delivery.`);
            }
            const {
                recoveryClaimedAt: _claimedAt,
                recoveryClaimId: _claimId,
                recoveryMessageAttemptedAt: _attemptedAt,
                recoveryMessageId: _messageId,
                ...rest
            } = record;
            const now = this.#now();
            return { ...rest, updatedAt: now };
        });
    }

    disableRecovery(document: WaitDocument, waitId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status === "consumed" || record.status === "cancelled") return record;
            if (record.recoveryDisabledAt !== undefined) return record;
            const now = this.#now();
            return { ...record, automaticRecovery: false, recoveryDisabledAt: now, updatedAt: now };
        });
    }

    dismissRecovery(document: WaitDocument, waitId: string, recoveryMessageId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (
                record.status !== "resolved" || record.detachedAt === undefined ||
                record.recoveryMessageAttemptedAt === undefined ||
                record.recoveryMessageId !== recoveryMessageId
            ) {
                throw invalidTransition(record, "dismiss uncertain recovery for");
            }
            const { recoveryClaimedAt: _claimedAt, recoveryClaimId: _claimId, ...rest } = record;
            const now = this.#now();
            return {
                ...rest,
                consumedAt: now,
                recoveryDismissedAt: now,
                status: "consumed",
                updatedAt: now,
            };
        });
    }

    completeRecovery(document: WaitDocument, waitId: string, claimId: string): WaitTransition {
        return this.#update(document, waitId, (record) => {
            if (record.status !== "resolved" || record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery claim does not match.`);
            }
            if (record.recoveryMessageSentAt === undefined) {
                throw new Error(`Wait ${waitId} recovery has not been durably marked sent.`);
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

    #reconcileTmuxWaits(document: WaitDocument): WaitDocument {
        const groups = new Map<string, WaitRecord[]>();
        for (const record of document.waits) {
            if (!blocksTmuxWaitCreation(record)) continue;
            const key = tmuxTargetKey(record);
            const group = groups.get(key);
            if (group === undefined) groups.set(key, [record]);
            else group.push(record);
        }

        const superseded = new Set<string>();
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            const winner = [...group].sort(compareTmuxWaitRecoveryPriority)[0]!;
            for (const record of group) {
                if (record.waitId !== winner.waitId) superseded.add(record.waitId);
            }
        }
        if (superseded.size === 0) return document;

        const now = this.#now();
        return {
            ...document,
            waits: document.waits.map((record) => {
                if (!superseded.has(record.waitId)) return record;
                const {
                    recoveryClaimedAt: _recoveryClaimedAt,
                    recoveryClaimId: _recoveryClaimId,
                    ...rest
                } = record;
                return {
                    ...rest,
                    cancelledAt: now,
                    status: "cancelled",
                    updatedAt: now,
                };
            }),
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
        ...(typeof value.automaticRecovery === "boolean" ? { automaticRecovery: value.automaticRecovery } : {}),
        ...(typeof value.cancelledAt === "string" ? { cancelledAt: value.cancelledAt } : {}),
        ...(typeof value.consumedAt === "string" ? { consumedAt: value.consumedAt } : {}),
        createdAt: storedText(value.createdAt, "createdAt"),
        createdByCtxId: storedText(value.createdByCtxId, "createdByCtxId"),
        ...(typeof value.deadlineAt === "string" ? { deadlineAt: storedText(value.deadlineAt, "deadlineAt") } : {}),
        ...(typeof value.detachedAt === "string" ? { detachedAt: value.detachedAt } : {}),
        ...(typeof value.goalId === "string" ? { goalId: storedText(value.goalId, "goalId") } : {}),
        ...(typeof value.goalProgressAt === "string" ? { goalProgressAt: storedText(value.goalProgressAt, "goalProgressAt") } : {}),
        ...(typeof value.goalRevision === "number" ? { goalRevision: positiveInteger(value.goalRevision, "goalRevision") } : {}),
        ...(typeof value.goalStepId === "string" ? { goalStepId: storedText(value.goalStepId, "goalStepId") } : {}),
        kind: kind(value.kind),
        ...(typeof value.ownerCallId === "string" ? { ownerCallId: value.ownerCallId } : {}),
        ...("payload" in value ? { payload: value.payload as JsonValue } : {}),
        ...(typeof value.recoveryClaimedAt === "string" ? { recoveryClaimedAt: value.recoveryClaimedAt } : {}),
        ...(typeof value.recoveryClaimId === "string" ? { recoveryClaimId: value.recoveryClaimId } : {}),
        ...(typeof value.recoveryDisabledAt === "string" ? { recoveryDisabledAt: value.recoveryDisabledAt } : {}),
        ...(typeof value.recoveryDismissedAt === "string" ? { recoveryDismissedAt: value.recoveryDismissedAt } : {}),
        ...(typeof value.recoveryMessageAttemptedAt === "string" ? { recoveryMessageAttemptedAt: value.recoveryMessageAttemptedAt } : {}),
        ...(typeof value.recoveryMessageId === "string" ? { recoveryMessageId: value.recoveryMessageId } : {}),
        ...(typeof value.recoveryMessageSentAt === "string" ? { recoveryMessageSentAt: value.recoveryMessageSentAt } : {}),
        ...(typeof value.recoveryRetryAfter === "string" ? { recoveryRetryAfter: storedText(value.recoveryRetryAfter, "recoveryRetryAfter") } : {}),
        ...(typeof value.recoveryRetryCount === "number" ? { recoveryRetryCount: nonNegativeInteger(value.recoveryRetryCount, "recoveryRetryCount") } : {}),
        ...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
        ...("result" in value ? { result: value.result as JsonValue } : {}),
        status,
        ...(typeof value.targetInstance === "string" ? { targetInstance: storedText(value.targetInstance, "targetInstance") } : {}),
        targetId: storedText(value.targetId, "targetId"),
        ...(typeof value.taskId === "string" ? { taskId: storedText(value.taskId, "taskId") } : {}),
        ...(typeof value.taskRevision === "number" ? { taskRevision: positiveInteger(value.taskRevision, "taskRevision") } : {}),
        ...(typeof value.todoItemId === "string" ? { todoItemId: storedText(value.todoItemId, "todoItemId") } : {}),
        updatedAt: storedText(value.updatedAt, "updatedAt"),
        waitId: storedText(value.waitId, "waitId"),
        ...(typeof value.workspace === "string" ? { workspace: storedText(value.workspace, "workspace") } : {}),
    };
}

function isTerminal(status: WaitStatus): boolean {
    return status === "consumed" || status === "cancelled";
}

function blocksTmuxWaitCreation(record: WaitRecord): boolean {
    if (record.kind !== "tmux") return false;
    if (record.status === "waiting" || record.status === "detached") return true;
    return record.status === "resolved" && record.recoveryMessageSentAt === undefined;
}

function sameTmuxTarget(record: WaitRecord, input: WaitCreateInput): boolean {
    return record.kind === "tmux" &&
        record.createdByCtxId === input.createdByCtxId &&
        record.targetId === input.targetId &&
        (record.targetInstance ?? "") === (input.targetInstance ?? "");
}

function tmuxTargetKey(record: WaitRecord): string {
    return JSON.stringify([record.createdByCtxId, record.targetInstance ?? "", record.targetId]);
}

function compareTmuxWaitRecoveryPriority(left: WaitRecord, right: WaitRecord): number {
    const priority = tmuxWaitRecoveryPriority(right) - tmuxWaitRecoveryPriority(left);
    if (priority !== 0) return priority;
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    if (updated !== 0) return updated;
    const created = right.createdAt.localeCompare(left.createdAt);
    if (created !== 0) return created;
    return right.waitId.localeCompare(left.waitId);
}

function tmuxWaitRecoveryPriority(record: WaitRecord): number {
    if (record.recoveryMessageAttemptedAt !== undefined && record.recoveryMessageSentAt === undefined) return 3;
    if (record.status === "resolved") return 2;
    if (record.status === "detached") return 1;
    return 0;
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

function nonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`wait ${field} must be a non-negative integer`);
    }
    return value;
}

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`wait ${field} must be a positive integer`);
    }
    return value;
}

function invalidTransition(record: WaitRecord, action: string): Error {
    return new Error(`Cannot ${action} wait ${record.waitId} while it is ${record.status}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
