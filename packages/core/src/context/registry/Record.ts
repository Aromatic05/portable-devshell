import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
    contextErrorCodes,
    createRemoteError,
    type ContextEnvironment,
    type ContextEnvironmentCleanup,
    type ContextExternalBinding,
    type ContextRecord,
} from "@portable-devshell/shared";
import {
    parseContextEnvironments,
    type ContextDocument,
    type ContextRemoteInstanceHandle,
    type ContextStoredRecord,
} from "../Model.js";

export function invalidContext(ctxId: string) {
    return contextError(
        contextErrorCodes.invalid,
        "ctxId is invalid for the current environment.",
        { ctxId },
    );
}

export function invalidRemoteHandle(ctxId: string) {
    return contextError(
        contextErrorCodes.invalid,
        "Remote instance handle is invalid for the current Context. Obtain a current handle with devshell instance list or status.",
        { ctxId },
    );
}

export function maskedInstance(ctxId: string, instance: string) {
    return contextError(
        contextErrorCodes.instanceMasked,
        "This remote instance is permanently masked for the lifetime of the current Context.",
        { ctxId, instance },
    );
}

export function invalidExternalBinding() {
    return contextError(
        contextErrorCodes.invalid,
        "No valid Context is bound to the current external identity.",
    );
}

export function expiredContext(ctxId: string, expiresAt: string) {
    return contextError(
        contextErrorCodes.expired,
        "ctxId lease has expired. Call environ_info to reactivate the same Context.",
        { ctxId, expiresAt },
    );
}

export function disabledContext(ctxId: string) {
    return contextError(
        contextErrorCodes.disabled,
        "ctxId is disabled and cannot be reactivated. Call environ_info with workspace to establish a new active Context.",
        { ctxId },
    );
}

export function isCtxId(value: string): boolean {
    return value.startsWith("ctx-") && value.length > 4;
}

export function cloneRecord(record: ContextStoredRecord): ContextRecord {
    return {
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        environments: structuredClone(record.environments),
        expiresAt: record.expiresAt,
        lastAccessedAt: record.lastAccessedAt,
        principal: record.principal,
        status: record.status,
    };
}

export function cloneRecordForRead(
    record: ContextStoredRecord,
    now: number,
): ContextRecord {
    const cloned = cloneRecord(record);
    return cloned.status === "active" && Date.parse(cloned.expiresAt) <= now
        ? { ...cloned, status: "expired" }
        : cloned;
}

export function cloneStoredRecord(
    record: ContextStoredRecord,
): ContextStoredRecord {
    return structuredClone(record);
}

export function contextEnvironment(
    record: ContextRecord,
    instance: string,
): ContextEnvironment | undefined {
    return record.environments.find(
        (environment) => environment.instance === instance,
    );
}

export function cloneContextMap(
    contexts: ReadonlyMap<string, ContextStoredRecord>,
): Map<string, ContextStoredRecord> {
    return structuredClone(new Map(contexts));
}

export function restoreContextMap(
    contexts: Map<string, ContextStoredRecord>,
    previous: ReadonlyMap<string, ContextStoredRecord>,
): void {
    contexts.clear();
    for (const [ctxId, record] of cloneContextMap(previous))
        contexts.set(ctxId, record);
}

export function isDocument(value: unknown): value is ContextDocument {
    return (
        isObject(value) && value.version === 2 && Array.isArray(value.contexts)
    );
}

export function parseRecord(value: unknown): ContextStoredRecord | undefined {
    if (!isObject(value)) return undefined;
    const raw = value;
    const record = value as Partial<ContextStoredRecord>;
    const status = raw.status;
    const parsedBindings = Array.isArray(record.externalBindings)
        ? record.externalBindings.map(parseExternalBinding)
        : [];
    if (parsedBindings.some((binding) => binding === undefined))
        return undefined;
    const externalBindings = uniqueExternalBindings(
        parsedBindings as ContextExternalBinding[],
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
        throw new Error("Invalid Context environment cleanup state.");
    }
    const pendingEnvironmentCleanup =
        raw.pendingEnvironmentCleanup?.map(parseEnvironmentCleanup) ?? [];
    if (pendingEnvironmentCleanup.some((cleanup) => cleanup === undefined)) {
        throw new Error("Invalid Context environment cleanup state.");
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
    return {
        ...(raw.cleanupPending === undefined
            ? {}
            : { cleanupPending: raw.cleanupPending as boolean }),
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
                      pendingEnvironmentCleanup as ContextEnvironmentCleanup[],
              }),
        ...(remoteInstanceHandles.length === 0
            ? {}
            : {
                  remoteInstanceHandles:
                      remoteInstanceHandles as ContextRemoteInstanceHandle[],
              }),
        expiresAt: record.expiresAt,
        lastAccessedAt: record.lastAccessedAt,
        principal: record.principal,
        status: status as "active" | "expired" | "disabled",
    };
}

export function parseRemoteInstanceHandle(
    value: unknown,
): ContextRemoteInstanceHandle | undefined {
    if (!isObject(value)) return undefined;
    const { handle, instance } = value;
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
): ContextEnvironmentCleanup | undefined {
    if (!isObject(value)) return undefined;
    const cleanup = value;
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

export function sameEnvironmentCleanup(
    left: ContextEnvironmentCleanup,
    right: ContextEnvironmentCleanup,
): boolean {
    return (
        left.kind === right.kind &&
        left.instance === right.instance &&
        (left.kind !== "alerts" ||
            (right.kind === "alerts" && left.workspace === right.workspace))
    );
}

export function appendEnvironmentCleanup(
    record: ContextStoredRecord,
    cleanup: ContextEnvironmentCleanup,
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
        { ...cleanup },
    ];
}

export function parseExternalBinding(
    value: unknown,
): ContextExternalBinding | undefined {
    return isExternalBinding(value) ? { ...value } : undefined;
}

export function isExternalBinding(
    value: unknown,
): value is ContextExternalBinding {
    if (!isObject(value)) return false;
    const binding = value;
    return (
        typeof binding.kind === "string" &&
        binding.kind.length > 0 &&
        typeof binding.value === "string" &&
        binding.value.length > 0
    );
}

export function sameExternalBinding(
    left: ContextExternalBinding,
    right: ContextExternalBinding,
): boolean {
    return left.kind === right.kind && left.value === right.value;
}

export function bindExternalRecord(
    contexts: Iterable<ContextStoredRecord>,
    record: ContextStoredRecord,
    external: ContextExternalBinding,
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
    bindings: ContextExternalBinding[],
): ContextExternalBinding[] {
    const unique = new Map<string, ContextExternalBinding>();
    for (const binding of bindings) {
        unique.set(`${binding.kind}\0${binding.value}`, binding);
    }
    return [...unique.values()];
}

export function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return isObject(error) && error.code === "ENOENT";
}

export interface ContextStatePort {
    readonly records: Map<string, ContextStoredRecord>;
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
                        (binding) => !isExternalBinding(binding),
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
                        (handle) =>
                            !isObject(handle) ||
                            typeof handle.handle !== "string" ||
                            !handle.handle.startsWith("ih-") ||
                            typeof handle.instance !== "string" ||
                            handle.instance.length === 0,
                    ))) ||
            (item.pendingEnvironmentCleanup !== undefined &&
                (!Array.isArray(item.pendingEnvironmentCleanup) ||
                    item.pendingEnvironmentCleanup.some(
                        (cleanup) =>
                            parseEnvironmentCleanup(cleanup) === undefined,
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

function contextError(
    code: string,
    message: string,
    details?: Record<string, string>,
) {
    return createRemoteError({
        code,
        ...(details === undefined ? {} : { details }),
        message,
        retryable: false,
    });
}
