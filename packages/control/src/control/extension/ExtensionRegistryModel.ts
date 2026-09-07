export const EXTENSION_REGISTRY_SCHEMA_VERSION = 1;

export interface ExtensionRegistryEntry {
    enabled: boolean;
    lastKnownGoodGeneration?: string;
    selectedGeneration?: string;
}

export interface ExtensionRegistrySnapshot {
    extensions: Record<string, ExtensionRegistryEntry>;
    schemaVersion: number;
}

export function emptyExtensionRegistry(): ExtensionRegistrySnapshot {
    return { extensions: {}, schemaVersion: EXTENSION_REGISTRY_SCHEMA_VERSION };
}

export function parseExtensionRegistry(value: unknown): ExtensionRegistrySnapshot {
    if (!isRecord(value)) throw new TypeError("Extension registry must be an object.");
    assertOnlyKeys(value, ["extensions", "schemaVersion"]);
    if (value.schemaVersion !== EXTENSION_REGISTRY_SCHEMA_VERSION) {
        throw new TypeError(`Unsupported Extension registry schemaVersion: ${String(value.schemaVersion)}.`);
    }
    if (!isRecord(value.extensions)) throw new TypeError("Extension registry extensions must be an object.");

    const extensions: Record<string, ExtensionRegistryEntry> = {};
    for (const [id, rawEntry] of Object.entries(value.extensions)) {
        assertExtensionId(id);
        if (!isRecord(rawEntry)) throw new TypeError(`Extension registry entry ${id} must be an object.`);
        assertOnlyKeys(rawEntry, ["enabled", "lastKnownGoodGeneration", "selectedGeneration"]);
        if (typeof rawEntry.enabled !== "boolean") {
            throw new TypeError(`Extension registry entry ${id}.enabled must be boolean.`);
        }
        extensions[id] = {
            enabled: rawEntry.enabled,
            ...(rawEntry.lastKnownGoodGeneration === undefined
                ? {}
                : { lastKnownGoodGeneration: readGeneration(rawEntry.lastKnownGoodGeneration, id) }),
            ...(rawEntry.selectedGeneration === undefined
                ? {}
                : { selectedGeneration: readGeneration(rawEntry.selectedGeneration, id) })
        };
    }
    return { extensions, schemaVersion: EXTENSION_REGISTRY_SCHEMA_VERSION };
}

export function cloneExtensionRegistry(snapshot: ExtensionRegistrySnapshot): ExtensionRegistrySnapshot {
    return {
        extensions: Object.fromEntries(
            Object.entries(snapshot.extensions).map(([id, entry]) => [id, { ...entry }])
        ),
        schemaVersion: snapshot.schemaVersion
    };
}

export function assertExtensionId(id: string): void {
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
        throw new TypeError(`Invalid Extension id: ${id}.`);
    }
}

export function assertExtensionGeneration(generation: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(generation)) {
        throw new TypeError(`Invalid Extension generation: ${generation}.`);
    }
}

function readGeneration(value: unknown, id: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`Extension registry generation for ${id} must be a string.`);
    }
    assertExtensionGeneration(value);
    return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
    if (unknown.length > 0) throw new TypeError(`Unknown Extension registry field: ${unknown[0]}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
