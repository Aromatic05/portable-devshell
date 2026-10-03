import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createRemoteError, contextErrorCodes, type McpContextEnvironment } from "@portable-devshell/shared";
import type { ContextExecutionRecord } from "./Reentry.js";
import {
    AUTOMATIC_REENTRY_CLAIM_TTL_MS,
    parseContextEnvironments,
    type McpContextAutomaticReentryState,
    type McpContextDocument,
    type McpContextEnvironmentCleanup,
    type McpContextExternalBinding,
    type McpContextRecord,
    type McpContextRemoteInstanceHandle,
    type McpContextStoredRecord,
} from "../Model.js";

export function invalidContext(ctxId: string) {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        details: { ctxId },
        message: "ctxId is invalid for the current environment.",
        retryable: false,
    });
}

export function invalidRemoteHandle(ctxId: string) {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        details: { ctxId },
        message:
            "Remote instance handle is invalid for the current Context. Obtain a current handle with devshell instance list or status.",
        retryable: false,
    });
}

export function maskedInstance(ctxId: string, instance: string) {
    return createRemoteError({
        code: contextErrorCodes.instanceMasked,
        details: { ctxId, instance },
        message:
            "This remote instance is permanently masked for the lifetime of the current Context.",
        retryable: false,
    });
}

export function invalidExternalBinding() {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        message: "No valid Context is bound to the current external identity.",
        retryable: false,
    });
}

export function expiredContext(ctxId: string, expiresAt: string) {
    return createRemoteError({
        code: contextErrorCodes.expired,
        details: { ctxId, expiresAt },
        message:
            "ctxId lease has expired. Call environ_info to reactivate the same Context.",
        retryable: false,
    });
}

export function disabledContext(ctxId: string) {
    return createRemoteError({
        code: contextErrorCodes.disabled,
        details: { ctxId },
        message:
            "ctxId is disabled and cannot be reactivated. Call environ_info with workspace to establish a new active Context.",
        retryable: false,
    });
}

export function isCtxId(value: string): boolean {
    return value.startsWith("ctx-") && value.length > 4;
}

export function cloneRecord(record: McpContextStoredRecord): McpContextRecord {
    const {
        cleanupPending: _cleanupPending,
        executionEpoch: _executionEpoch,
        executionLastActivityAt: _executionLastActivityAt,
        executionLeaseUntil: _executionLeaseUntil,
        automaticReentryAttemptedAt: _automaticReentryAttemptedAt,
        automaticReentryClaimedAt: _automaticReentryClaimedAt,
        automaticReentryClaimId: _automaticReentryClaimId,
        automaticReentryMode: _automaticReentryMode,
        automaticReentryInstance: _automaticReentryInstance,
        automaticReentryEpoch: _automaticReentryEpoch,
        automaticReentrySuppressedAt: _automaticReentrySuppressedAt,
        automaticReentrySuppressionReason: _automaticReentrySuppressionReason,
        automaticReentrySourceId: _automaticReentrySourceId,
        automaticReentrySourceKind: _automaticReentrySourceKind,
        externalBindings: _externalBindings,
        maskedInstances: _maskedInstances,
        pendingEnvironmentCleanup: _pendingEnvironmentCleanup,
        remoteInstanceHandles: _remoteInstanceHandles,
        ...publicRecord
    } = record;
    return {
        ...publicRecord,
        environments: record.environments.map((environment) => ({
            ...environment,
        })),
    };
}

export function cloneRecordForRead(
    record: McpContextStoredRecord,
    now: number,
): McpContextRecord {
    const cloned = cloneRecord(record);
    return cloned.status === "active" && Date.parse(cloned.expiresAt) <= now
        ? { ...cloned, status: "expired" }
        : cloned;
}

export function cloneStoredRecord(
    record: McpContextStoredRecord,
): McpContextStoredRecord {
    return {
        ...record,
        externalBindings: record.externalBindings?.map((binding) => ({
            ...binding,
        })),
        maskedInstances:
            record.maskedInstances === undefined
                ? undefined
                : [...record.maskedInstances],
        pendingEnvironmentCleanup: record.pendingEnvironmentCleanup?.map(
            cloneEnvironmentCleanup,
        ),
        remoteInstanceHandles: record.remoteInstanceHandles?.map(
            (reference) => ({ ...reference }),
        ),
        environments: record.environments.map((environment) => ({
            ...environment,
        })),
    };
}

export function contextEnvironment(
    record: McpContextRecord,
    instance: string,
): McpContextEnvironment | undefined {
    return record.environments.find(
        (environment) => environment.instance === instance,
    );
}

export function cloneContextMap(
    contexts: ReadonlyMap<string, McpContextStoredRecord>,
): Map<string, McpContextStoredRecord> {
    return new Map(
        [...contexts].map(([ctxId, record]) => [
            ctxId,
            cloneStoredRecord(record),
        ]),
    );
}

export function restoreContextMap(
    contexts: Map<string, McpContextStoredRecord>,
    previous: ReadonlyMap<string, McpContextStoredRecord>,
): void {
    contexts.clear();
    for (const [ctxId, record] of previous) {
        contexts.set(ctxId, cloneStoredRecord(record));
    }
}

export function isDocument(value: unknown): value is McpContextDocument {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { version?: unknown }).version === 2 &&
        Array.isArray((value as { contexts?: unknown }).contexts)
    );
}

export function parseRecord(value: unknown): McpContextStoredRecord | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const record = value as Partial<McpContextStoredRecord>;
    const status = raw.status;
    const parsedBindings = Array.isArray(record.externalBindings)
        ? record.externalBindings.map(parseExternalBinding)
        : [];
    if (parsedBindings.some((binding) => binding === undefined))
        return undefined;
    const externalBindings = uniqueExternalBindings(
        parsedBindings as McpContextExternalBinding[],
    );
    const remoteInstanceHandles = Array.isArray(raw.remoteInstanceHandles)
        ? raw.remoteInstanceHandles.map(parseRemoteInstanceHandle)
        : [];
    if (remoteInstanceHandles.some((reference) => reference === undefined))
        return undefined;
    const maskedInstances = Array.isArray(raw.maskedInstances)
        ? raw.maskedInstances.map((instance) =>
              typeof instance === "string" && instance.length > 0
                  ? instance
                  : undefined,
          )
        : [];
    if (maskedInstances.some((instance) => instance === undefined))
        return undefined;
    if (
        raw.pendingEnvironmentCleanup !== undefined &&
        !Array.isArray(raw.pendingEnvironmentCleanup)
    ) {
        throw new Error("Invalid MCP Context environment cleanup state.");
    }
    const pendingEnvironmentCleanup =
        raw.pendingEnvironmentCleanup?.map(parseEnvironmentCleanup) ?? [];
    if (pendingEnvironmentCleanup.some((cleanup) => cleanup === undefined)) {
        throw new Error("Invalid MCP Context environment cleanup state.");
    }
    if (
        typeof record.ctxId !== "string" ||
        !isCtxId(record.ctxId) ||
        typeof record.principal !== "string" ||
        typeof record.createdAt !== "string" ||
        typeof record.lastAccessedAt !== "string" ||
        typeof record.expiresAt !== "string" ||
        (raw.cleanupPending !== undefined &&
            typeof raw.cleanupPending !== "boolean") ||
        (status !== "active" && status !== "expired" && status !== "disabled")
    ) {
        return undefined;
    }
    const environments = parseContextEnvironments(record.environments);
    if (environments === undefined) return undefined;
    const automaticReentryInstance =
        typeof raw.automaticReentryInstance === "string" &&
        environments.some(
            (environment) =>
                environment.instance === raw.automaticReentryInstance,
        )
            ? raw.automaticReentryInstance
            : undefined;
    return {
        ...(raw.cleanupPending === undefined
            ? {}
            : { cleanupPending: raw.cleanupPending as boolean }),
        ...(typeof raw.executionEpoch === "number" &&
        Number.isSafeInteger(raw.executionEpoch) &&
        raw.executionEpoch >= 0
            ? { executionEpoch: raw.executionEpoch }
            : {}),
        ...(typeof raw.executionLastActivityAt === "string" &&
        raw.executionLastActivityAt.length > 0
            ? { executionLastActivityAt: raw.executionLastActivityAt }
            : {}),
        ...(typeof raw.executionLeaseUntil === "string" &&
        raw.executionLeaseUntil.length > 0
            ? { executionLeaseUntil: raw.executionLeaseUntil }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentryAttemptedAt === "string" &&
        raw.automaticReentryAttemptedAt.length > 0
            ? { automaticReentryAttemptedAt: raw.automaticReentryAttemptedAt }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentryClaimedAt === "string" &&
        raw.automaticReentryClaimedAt.length > 0
            ? { automaticReentryClaimedAt: raw.automaticReentryClaimedAt }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentryClaimId === "string" &&
        raw.automaticReentryClaimId.length > 0
            ? { automaticReentryClaimId: raw.automaticReentryClaimId }
            : {}),
        ...(automaticReentryInstance === undefined
            ? {}
            : { automaticReentryInstance }),
        ...(typeof raw.automaticReentryEpoch === "number" &&
        Number.isSafeInteger(raw.automaticReentryEpoch) &&
        raw.automaticReentryEpoch >= 0
            ? { automaticReentryEpoch: raw.automaticReentryEpoch }
            : {}),
        ...(raw.automaticReentryMode === "user_owned" ||
        raw.automaticReentryMode === "paused"
            ? { automaticReentryMode: raw.automaticReentryMode }
            : {}),
        ...(typeof raw.automaticReentrySuppressedAt === "string" &&
        raw.automaticReentrySuppressedAt.length > 0
            ? { automaticReentrySuppressedAt: raw.automaticReentrySuppressedAt }
            : {}),
        ...(typeof raw.automaticReentrySuppressionReason === "string" &&
        raw.automaticReentrySuppressionReason.length > 0
            ? {
                  automaticReentrySuppressionReason:
                      raw.automaticReentrySuppressionReason,
              }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        typeof raw.automaticReentrySourceId === "string" &&
        raw.automaticReentrySourceId.length > 0
            ? { automaticReentrySourceId: raw.automaticReentrySourceId }
            : {}),
        ...(automaticReentryInstance !== undefined &&
        (raw.automaticReentrySourceKind === "goal" ||
            raw.automaticReentrySourceKind === "goal-resume" ||
            raw.automaticReentrySourceKind === "goal-retry" ||
            raw.automaticReentrySourceKind === "task-resume" ||
            raw.automaticReentrySourceKind === "wait")
            ? { automaticReentrySourceKind: raw.automaticReentrySourceKind }
            : {}),
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        environments,
        ...(externalBindings.length === 0 ? {} : { externalBindings }),
        ...(maskedInstances.length === 0
            ? {}
            : { maskedInstances: [...new Set(maskedInstances as string[])] }),
        ...(pendingEnvironmentCleanup.length === 0
            ? {}
            : {
                  pendingEnvironmentCleanup:
                      pendingEnvironmentCleanup as McpContextEnvironmentCleanup[],
              }),
        ...(remoteInstanceHandles.length === 0
            ? {}
            : {
                  remoteInstanceHandles:
                      remoteInstanceHandles as McpContextRemoteInstanceHandle[],
              }),
        expiresAt: record.expiresAt,
        lastAccessedAt: record.lastAccessedAt,
        principal: record.principal,
        status: status as "active" | "expired" | "disabled",
    };
}

export function parseRemoteInstanceHandle(
    value: unknown,
): McpContextRemoteInstanceHandle | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const handle = (value as { handle?: unknown }).handle;
    const instance = (value as { instance?: unknown }).instance;
    return typeof handle === "string" &&
        handle.startsWith("ih-") &&
        handle.length > 3 &&
        typeof instance === "string" &&
        instance.length > 0
        ? { handle, instance }
        : undefined;
}

export function parseEnvironmentCleanup(
    value: unknown,
): McpContextEnvironmentCleanup | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const cleanup = value as Record<string, unknown>;
    if (typeof cleanup.instance !== "string" || cleanup.instance.length === 0) {
        return undefined;
    }
    if (cleanup.kind === "instance_reference") {
        return {
            instance: cleanup.instance,
            kind: "instance_reference",
        };
    }
    if (
        cleanup.kind === "alerts" &&
        typeof cleanup.workspace === "string" &&
        cleanup.workspace.length > 0
    ) {
        return {
            instance: cleanup.instance,
            kind: "alerts",
            workspace: cleanup.workspace,
        };
    }
    return undefined;
}

export function cloneEnvironmentCleanup(
    cleanup: McpContextEnvironmentCleanup,
): McpContextEnvironmentCleanup {
    return { ...cleanup };
}

export function sameEnvironmentCleanup(
    left: McpContextEnvironmentCleanup,
    right: McpContextEnvironmentCleanup,
): boolean {
    return (
        left.kind === right.kind &&
        left.instance === right.instance &&
        (left.kind !== "alerts" ||
            (right.kind === "alerts" && left.workspace === right.workspace))
    );
}

export function appendEnvironmentCleanup(
    record: McpContextStoredRecord,
    cleanup: McpContextEnvironmentCleanup,
): void {
    if (
        (record.pendingEnvironmentCleanup ?? []).some((candidate) =>
            sameEnvironmentCleanup(candidate, cleanup),
        )
    ) {
        return;
    }
    record.pendingEnvironmentCleanup = [
        ...(record.pendingEnvironmentCleanup ?? []),
        cloneEnvironmentCleanup(cleanup),
    ];
}

export function automaticReentryState(
    record: McpContextStoredRecord,
    now = Date.now(),
): McpContextAutomaticReentryState {
    const pending = automaticReentryClaimFresh(record, now);
    return {
        attempted:
            record.automaticReentryInstance !== undefined &&
            record.automaticReentryAttemptedAt !== undefined,
        ...(pending && record.automaticReentryClaimId !== undefined
            ? { claimId: record.automaticReentryClaimId }
            : {}),
        epoch: record.automaticReentryEpoch ?? 0,
        executionActive: contextExecutionActive(record, now),
        executionEpoch: record.executionEpoch ?? 0,
        ...(record.executionLastActivityAt === undefined
            ? {}
            : { executionLastActivityAt: record.executionLastActivityAt }),
        ...(record.executionLeaseUntil === undefined
            ? {}
            : { executionLeaseUntil: record.executionLeaseUntil }),
        mode: record.automaticReentryMode ?? "automatic",
        pending,
        ...(record.automaticReentrySuppressedAt === undefined
            ? {}
            : { suppressedAt: record.automaticReentrySuppressedAt }),
        ...(record.automaticReentrySuppressionReason === undefined
            ? {}
            : { reason: record.automaticReentrySuppressionReason }),
        ...(record.automaticReentrySourceId === undefined
            ? {}
            : { sourceId: record.automaticReentrySourceId }),
        ...(record.automaticReentrySourceKind === undefined
            ? {}
            : { sourceKind: record.automaticReentrySourceKind }),
    };
}

export function clearAutomaticReentryClaim(record: McpContextStoredRecord): void {
    delete record.automaticReentryAttemptedAt;
    delete record.automaticReentryClaimedAt;
    delete record.automaticReentryClaimId;
    delete record.automaticReentryInstance;
    delete record.automaticReentrySourceId;
    delete record.automaticReentrySourceKind;
}

export function applyExecutionRecord(
    record: McpContextStoredRecord,
    execution: ContextExecutionRecord,
): void {
    record.executionEpoch = execution.executionEpoch;
    if (execution.executionLastActivityAt === undefined)
        delete record.executionLastActivityAt;
    else record.executionLastActivityAt = execution.executionLastActivityAt;
    if (execution.executionLeaseUntil === undefined)
        delete record.executionLeaseUntil;
    else record.executionLeaseUntil = execution.executionLeaseUntil;
}

export function executionRecord(
    record: McpContextStoredRecord,
): ContextExecutionRecord {
    return {
        executionEpoch: record.executionEpoch ?? 0,
        ...(record.executionLastActivityAt === undefined
            ? {}
            : { executionLastActivityAt: record.executionLastActivityAt }),
        ...(record.executionLeaseUntil === undefined
            ? {}
            : { executionLeaseUntil: record.executionLeaseUntil }),
    };
}

export function contextExecutionFilePath(
    filePath: string | undefined,
): string | undefined {
    if (filePath === undefined) return undefined;
    return filePath.endsWith(".json")
        ? `${filePath.slice(0, -5)}.activity.sqlite3`
        : `${filePath}.activity.sqlite3`;
}

export function contextExecutionActive(
    record: McpContextStoredRecord,
    now: number,
): boolean {
    if (record.executionLeaseUntil === undefined) return false;
    const leaseUntil = Date.parse(record.executionLeaseUntil);
    return Number.isFinite(leaseUntil) && now < leaseUntil;
}

export function automaticReentryClaimFresh(
    record: McpContextStoredRecord,
    now: number,
): boolean {
    if (
        record.automaticReentryInstance === undefined ||
        record.automaticReentryClaimId === undefined ||
        record.automaticReentryClaimedAt === undefined
    )
        return false;
    if (record.automaticReentryAttemptedAt !== undefined) return true;
    const claimedAt = Date.parse(record.automaticReentryClaimedAt);
    return (
        Number.isFinite(claimedAt) &&
        now - claimedAt < AUTOMATIC_REENTRY_CLAIM_TTL_MS
    );
}

export function parseExternalBinding(
    value: unknown,
): McpContextExternalBinding | undefined {
    return isExternalBinding(value) ? { ...value } : undefined;
}

export function isExternalBinding(value: unknown): value is McpContextExternalBinding {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const binding = value as Partial<McpContextExternalBinding>;
    return (
        typeof binding.kind === "string" &&
        binding.kind.length > 0 &&
        typeof binding.value === "string" &&
        binding.value.length > 0
    );
}

export function sameExternalBinding(
    left: McpContextExternalBinding,
    right: McpContextExternalBinding,
): boolean {
    return left.kind === right.kind && left.value === right.value;
}

export function bindExternalRecord(
    contexts: Iterable<McpContextStoredRecord>,
    record: McpContextStoredRecord,
    external: McpContextExternalBinding,
    principal: string,
): void {
    for (const existing of contexts) {
        if (existing.principal !== principal) continue;
        existing.externalBindings = (existing.externalBindings ?? []).filter(
            (candidate) => !sameExternalBinding(candidate, external),
        );
        if (existing.externalBindings.length === 0) {
            existing.externalBindings = undefined;
        }
    }
    record.externalBindings = [
        ...(record.externalBindings ?? []),
        { ...external },
    ];
}

export function uniqueExternalBindings(
    bindings: McpContextExternalBinding[],
): McpContextExternalBinding[] {
    const unique = new Map<string, McpContextExternalBinding>();
    for (const binding of bindings) {
        unique.set(`${binding.kind}\0${binding.value}`, binding);
    }
    return [...unique.values()];
}

export function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
    );
}


export interface ContextStatePort {
    readonly records: Map<string, McpContextStoredRecord>;
    assertInitialized(): void;
    run<Result>(operation: () => Promise<Result>): Promise<Result>;
    mutate(operation: () => void): Promise<void>;
}

export async function upgradeContextDocument(filePath: string): Promise<void> {
    const contents = await readFile(filePath, "utf8");
    const migrated = migrateContextDocument(JSON.parse(contents) as unknown);
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.migration`;
    const file = await open(temporary, "wx", 0o600);
    try {
        await file.writeFile(`${JSON.stringify(migrated)}\n`, "utf8");
        await file.sync();
    } catch (error) {
        await file.close();
        await rm(temporary, { force: true });
        throw error;
    }
    await file.close();
    try {
        await rename(temporary, filePath);
        if (process.platform !== "win32") {
            const parent = await open(directory, "r");
            try {
                await parent.sync();
            } finally {
                await parent.close();
            }
        }
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

export function migrateContextDocument(
    value: unknown,
): Record<string, unknown> {
    if (
        !isObject(value) ||
        value.version !== 1 ||
        !Array.isArray(value.contexts)
    ) {
        throw new Error("Invalid Context registry v1 document.");
    }
    const contexts = value.contexts.map((item, index) => {
        if (!isObject(item) || !Array.isArray(item.environments)) {
            throw new Error(
                `Context registry migration needed: record ${index} has missing environments.`,
            );
        }
        const hasLegacyIdentity =
            item.externalSelector !== undefined ||
            item.openAiSessionId !== undefined ||
            item.sessionId !== undefined;
        if (
            hasLegacyIdentity &&
            (!Array.isArray(item.externalBindings) ||
                item.externalBindings.length === 0)
        ) {
            throw new Error(
                `Context registry migration needed: record ${index} has legacy external identity without canonical externalBindings.`,
            );
        }
        if (
            typeof item.ctxId !== "string" ||
            !item.ctxId.startsWith("ctx-") ||
            item.ctxId.length <= 4 ||
            typeof item.principal !== "string" ||
            typeof item.instance !== "string" ||
            typeof item.workspace !== "string" ||
            typeof item.createdAt !== "string" ||
            typeof item.lastAccessedAt !== "string" ||
            typeof item.expiresAt !== "string" ||
            (item.temporaryDirectory !== undefined &&
                typeof item.temporaryDirectory !== "string") ||
            (item.status !== "active" &&
                item.status !== "expired" &&
                item.status !== "disabled") ||
            (item.cleanupPending !== undefined &&
                typeof item.cleanupPending !== "boolean") ||
            parseContextEnvironments(item.environments) === undefined ||
            (item.externalBindings !== undefined &&
                (!Array.isArray(item.externalBindings) ||
                    item.externalBindings.some(
                        (binding) => !validExternalBinding(binding),
                    ))) ||
            (item.maskedInstances !== undefined &&
                (!Array.isArray(item.maskedInstances) ||
                    item.maskedInstances.some(
                        (instance) =>
                            typeof instance !== "string" ||
                            instance.length === 0,
                    ))) ||
            (item.remoteInstanceHandles !== undefined &&
                (!Array.isArray(item.remoteInstanceHandles) ||
                    item.remoteInstanceHandles.some(
                        (handle) => !validRemoteHandle(handle),
                    ))) ||
            (item.pendingEnvironmentCleanup !== undefined &&
                (!Array.isArray(item.pendingEnvironmentCleanup) ||
                    item.pendingEnvironmentCleanup.some(
                        (cleanup) => !validCleanup(cleanup),
                    )))
        ) {
            throw new Error(
                `Invalid Context registry v1 environments in record ${index}; file was not rewritten.`,
            );
        }
        const migrated = { ...item };
        delete migrated.instance;
        delete migrated.workspace;
        delete migrated.temporaryDirectory;
        delete migrated.externalSelector;
        delete migrated.openAiSessionId;
        delete migrated.sessionId;
        return migrated;
    });
    return { contexts, version: 2 };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validExternalBinding(value: unknown): boolean {
    return (
        isObject(value) &&
        typeof value.kind === "string" &&
        value.kind.length > 0 &&
        typeof value.value === "string" &&
        value.value.length > 0
    );
}

function validRemoteHandle(value: unknown): boolean {
    return (
        isObject(value) &&
        typeof value.handle === "string" &&
        value.handle.startsWith("ih-") &&
        typeof value.instance === "string" &&
        value.instance.length > 0
    );
}

function validCleanup(value: unknown): boolean {
    return (
        isObject(value) &&
        typeof value.instance === "string" &&
        value.instance.length > 0 &&
        (value.kind === "instance_reference" ||
            (value.kind === "alerts" &&
                typeof value.workspace === "string" &&
                value.workspace.length > 0))
    );
}
