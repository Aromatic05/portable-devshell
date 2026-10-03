import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { parseContextEnvironments } from "./Model.js";

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
