import type { ExtensionCapability, ExtensionManifest } from "./ExtensionApi.js";

export const EXTENSION_API_VERSION = 1;
export const EXTENSION_MANIFEST_SCHEMA_VERSION = 1;

const capabilities = new Set<ExtensionCapability>([
    "command",
    "data",
    "instance-lifecycle",
    "rpc",
    "web",
    "worker"
]);

export function parseExtensionManifest(value: unknown): ExtensionManifest {
    if (!isRecord(value)) throw new TypeError("Extension manifest must be an object.");
    assertOnlyKeys(value, ["apiVersion", "capabilities", "entry", "id", "name", "schemaVersion", "version"]);

    const schemaVersion = readPositiveInteger(value.schemaVersion, "schemaVersion");
    if (schemaVersion !== EXTENSION_MANIFEST_SCHEMA_VERSION) {
        throw new TypeError(`Unsupported Extension manifest schemaVersion: ${schemaVersion}.`);
    }
    const apiVersion = readPositiveInteger(value.apiVersion, "apiVersion");
    const id = readString(value.id, "id");
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
        throw new TypeError("Extension id must match [a-z][a-z0-9-]*.");
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
