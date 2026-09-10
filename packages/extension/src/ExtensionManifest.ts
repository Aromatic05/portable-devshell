import type {
    ExtensionCapability,
    ExtensionJsonValue,
    ExtensionManifest,
    ExtensionPointDeclaration
} from "./ExtensionApi.js";

export const EXTENSION_API_VERSION = 4;
export const EXTENSION_MANIFEST_SCHEMA_VERSION = 1;

const capabilities = new Set<ExtensionCapability>([
    "artifacts",
    "assets",
    "delegatedWorkers",
    "instances",
    "processes",
    "workers"
]);

export function parseExtensionManifest(value: unknown): ExtensionManifest {
    if (!isRecord(value)) throw new TypeError("Extension manifest must be an object.");
    assertOnlyKeys(value, [
        "apiVersion",
        "capabilities",
        "entry",
        "extensions",
        "hostDependencies",
        "id",
        "name",
        "schemaVersion",
        "version"
    ]);

    const schemaVersion = readPositiveInteger(value.schemaVersion, "schemaVersion");
    if (schemaVersion !== EXTENSION_MANIFEST_SCHEMA_VERSION) {
        throw new TypeError(`Unsupported Extension manifest schemaVersion: ${schemaVersion}.`);
    }
    const apiVersion = readPositiveInteger(value.apiVersion, "apiVersion");
    if (apiVersion !== EXTENSION_API_VERSION) {
        throw new TypeError(`Unsupported Extension apiVersion: ${apiVersion}.`);
    }
    const id = readLocalId(value.id, "id");
    const entry = readString(value.entry, "entry");
    if (entry.startsWith("/") || entry.startsWith("\\") || entry.split(/[\\/]/u).includes("..")) {
        throw new TypeError("Extension entry must be a relative path inside its generation directory.");
    }
    const capabilityValues = value.capabilities;
    if (!Array.isArray(capabilityValues)) throw new TypeError("Extension capabilities must be an array.");
    const parsedCapabilities = capabilityValues.map((candidate) => {
        if (typeof candidate !== "string" || !capabilities.has(candidate as ExtensionCapability)) {
            throw new TypeError(`Unknown Extension capability: ${String(candidate)}.`);
        }
        return candidate as ExtensionCapability;
    });
    if (new Set(parsedCapabilities).size !== parsedCapabilities.length) {
        throw new TypeError("Extension capabilities must not contain duplicates.");
    }
    return {
        apiVersion,
        capabilities: parsedCapabilities,
        entry,
        extensions: readExtensions(value.extensions),
        hostDependencies: readHostDependencies(value.hostDependencies),
        id,
        name: readString(value.name, "name"),
        schemaVersion,
        version: readString(value.version, "version")
    };
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
    if (unknown.length > 0) throw new TypeError(`Unknown Extension manifest field: ${unknown[0]}.`);
}

function readPositiveInteger(value: unknown, field: string): number {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    throw new TypeError(`Extension manifest ${field} must be a positive integer.`);
}

function readString(value: unknown, field: string): string {
    if (typeof value === "string" && value.length > 0 && value.trim() === value) return value;
    throw new TypeError(`Extension manifest ${field} must be a non-empty trimmed string.`);
}

function readLocalId(value: unknown, field: string): string {
    const id = readString(value, field);
    if (/^[a-z][a-z0-9-]*$/u.test(id)) return id;
    throw new TypeError(`Extension manifest ${field} must match [a-z][a-z0-9-]*.`);
}

function readExtensions(value: unknown): Readonly<Record<string, readonly ExtensionPointDeclaration[]>> {
    if (value === undefined) return {};
    if (!isRecord(value)) throw new TypeError("Extension extensions must be an object.");
    const extensions: Record<string, readonly ExtensionPointDeclaration[]> = {};
    for (const [pointId, declarations] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(pointId)) {
            throw new TypeError(`Invalid Extension Point id: ${pointId}.`);
        }
        if (!Array.isArray(declarations)) {
            throw new TypeError(`Extension Point ${pointId} declarations must be an array.`);
        }
        const parsed = declarations.map((declaration, index) => readDeclaration(declaration, pointId, index));
        const ids = parsed.map((declaration) => declaration.id);
        if (new Set(ids).size !== ids.length) {
            throw new TypeError(`Extension Point ${pointId} declarations must not contain duplicate ids.`);
        }
        extensions[pointId] = parsed;
    }
    return extensions;
}

function readDeclaration(value: unknown, pointId: string, index: number): ExtensionPointDeclaration {
    if (!isRecord(value)) {
        throw new TypeError(`Extension Point ${pointId} declaration ${index} must be an object.`);
    }
    const id = readLocalId(value.id, `${pointId}[${index}].id`);
    const declaration: { id: string } & Record<string, ExtensionJsonValue> = { id };
    for (const [key, candidate] of Object.entries(value)) {
        if (key === "id") continue;
        declaration[key] = cloneJsonValue(candidate, `${pointId}[${index}].${key}`);
    }
    return declaration;
}

function cloneJsonValue(value: unknown, field: string): ExtensionJsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((candidate, index) => cloneJsonValue(candidate, `${field}[${index}]`));
    if (isRecord(value)) {
        const result: Record<string, ExtensionJsonValue> = {};
        for (const [key, candidate] of Object.entries(value)) result[key] = cloneJsonValue(candidate, `${field}.${key}`);
        return result;
    }
    throw new TypeError(`Extension manifest ${field} must be JSON-compatible.`);
}

function readHostDependencies(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError("Extension hostDependencies must be an array.");
    const dependencies = value.map((candidate) => {
        if (typeof candidate !== "string" || candidate.trim() !== candidate || !isPackageRoot(candidate)) {
            throw new TypeError(`Invalid Extension host dependency: ${String(candidate)}.`);
        }
        if (candidate.startsWith("@portable-devshell/")) {
            throw new TypeError("Extension hostDependencies must not expose portable-devshell internal packages.");
        }
        return candidate;
    });
    if (new Set(dependencies).size !== dependencies.length) {
        throw new TypeError("Extension hostDependencies must not contain duplicates.");
    }
    return dependencies;
}

function isPackageRoot(value: string): boolean {
    return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
