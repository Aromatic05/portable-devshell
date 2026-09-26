import type {
    ExtensionCapability,
    ExtensionConfigAccess,
    ExtensionJsonValue,
    ExtensionManifest,
    ExtensionPointDeclaration,
} from "./ExtensionApi.js";

export const EXTENSION_API_VERSION = "4.1.0";
export const EXTENSION_MANIFEST_SCHEMA_VERSION = "1.1.0";

const capabilities = new Set<ExtensionCapability>([
    "artifacts",
    "assets",
    "delegatedWorkers",
    "instances",
    "processes",
    "workers",
]);

/**
 * @compat extension-manifest-schema-v1
 * @removeAt 1.0.0
 */
export function parseExtensionManifest(value: unknown): ExtensionManifest {
    if (!isRecord(value))
        throw new TypeError("Extension manifest must be an object.");

    const schemaVersion = readCompatibilityVersion(
        value.schemaVersion,
        "schemaVersion",
    );
    assertCompatibleVersion(
        schemaVersion,
        EXTENSION_MANIFEST_SCHEMA_VERSION,
        "schemaVersion",
    );
    const schema = parseSemVer(schemaVersion, "schemaVersion");
    const supportsActivation =
        compareSemVer(schema, parseSemVer("1.1.0", "schemaVersion")) >= 0;
    const supportsConfig =
        compareSemVer(schema, parseSemVer("1.1.0", "schemaVersion")) >= 0;
    const supportsHostDependencyRanges =
        compareSemVer(schema, parseSemVer("1.1.0", "schemaVersion")) >= 0;
    assertOnlyKeys(value, [
        ...(supportsActivation ? ["activation"] : []),
        "apiVersion",
        "capabilities",
        ...(supportsConfig ? ["config"] : []),
        "entry",
        "extensions",
        "hostDependencies",
        "id",
        "name",
        "schemaVersion",
        "version",
    ]);

    const apiVersion = readCompatibilityVersion(value.apiVersion, "apiVersion");
    assertCompatibleVersion(apiVersion, EXTENSION_API_VERSION, "apiVersion");
    const activation = supportsActivation
        ? readActivationPolicy(value.activation)
        : "lazy";
    const id = readLocalId(value.id, "id");
    const entry = readString(value.entry, "entry");
    if (
        entry.startsWith("/") ||
        entry.startsWith("\\") ||
        entry.split(/[\\/]/u).includes("..")
    ) {
        throw new TypeError(
            "Extension entry must be a relative path inside its generation directory.",
        );
    }
    const capabilityValues = value.capabilities;
    if (!Array.isArray(capabilityValues))
        throw new TypeError("Extension capabilities must be an array.");
    const parsedCapabilities = capabilityValues.map((candidate) => {
        if (
            typeof candidate !== "string" ||
            !capabilities.has(candidate as ExtensionCapability)
        ) {
            throw new TypeError(
                `Unknown Extension capability: ${String(candidate)}.`,
            );
        }
        return candidate as ExtensionCapability;
    });
    if (new Set(parsedCapabilities).size !== parsedCapabilities.length) {
        throw new TypeError(
            "Extension capabilities must not contain duplicates.",
        );
    }
    return {
        activation,
        apiVersion,
        capabilities: parsedCapabilities,
        ...(supportsConfig && value.config !== undefined
            ? { config: readConfig(value.config) }
            : {}),
        entry,
        extensions: readExtensions(value.extensions),
        hostDependencies: readHostDependencies(
            value.hostDependencies,
            supportsHostDependencyRanges,
        ),
        id,
        name: readString(value.name, "name"),
        schemaVersion,
        version: readString(value.version, "version"),
    };
}

function readConfig(value: unknown): NonNullable<ExtensionManifest["config"]> {
    if (!isRecord(value))
        throw new TypeError("Extension manifest config must be an object.");
    assertOnlyKeys(value, ["access", "default", "schema"]);
    const hasDefault = Object.hasOwn(value, "default");
    const hasSchema = Object.hasOwn(value, "schema");
    if (hasDefault !== hasSchema) {
        throw new TypeError(
            "Extension manifest config.default and config.schema must be declared together.",
        );
    }
    const access = readConfigAccess(value.access);
    if (!hasDefault && access === undefined) {
        throw new TypeError(
            "Extension manifest config must declare an owned schema or access requests.",
        );
    }
    if (!hasDefault) return { access: access! };

    const defaultValue = cloneJsonValue(value.default, "config.default");
    if (!isRecord(defaultValue)) {
        throw new TypeError(
            "Extension manifest config.default must be a JSON object.",
        );
    }
    const schema = cloneJsonValue(value.schema, "config.schema");
    if (typeof schema !== "boolean" && !isRecord(schema)) {
        throw new TypeError(
            "Extension manifest config.schema must be a JSON Schema object or boolean.",
        );
    }
    return {
        ...(access === undefined ? {} : { access }),
        default: defaultValue as Record<string, ExtensionJsonValue>,
        schema: schema as
            | boolean
            | Record<string, ExtensionJsonValue>,
    };
}

function readConfigAccess(
    value: unknown,
): Readonly<Record<string, ExtensionConfigAccess>> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value))
        throw new TypeError("Extension manifest config.access must be an object.");
    const access: Record<string, ExtensionConfigAccess> = {};
    for (const [path, permission] of Object.entries(value)) {
        if (!isConfigPath(path)) {
            throw new TypeError(
                `Invalid Extension Config access path: ${path}.`,
            );
        }
        if (permission !== "read" && permission !== "read-write") {
            throw new TypeError(
                `Extension Config access for ${path} must be read or read-write.`,
            );
        }
        access[path] = permission;
    }
    if (Object.keys(access).length === 0)
        throw new TypeError(
            "Extension manifest config.access must not be empty.",
        );
    return access;
}

function isConfigPath(value: string): boolean {
    return /^[a-z][a-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(value);
}

function readActivationPolicy(
    value: unknown,
): ExtensionManifest["activation"] {
    if (value === "lazy" || value === "eager") return value;
    throw new TypeError(
        "Extension manifest activation must be either lazy or eager.",
    );
}

function assertOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): void {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
    if (unknown.length > 0)
        throw new TypeError(`Unknown Extension manifest field: ${unknown[0]}.`);
}

/**
 * @compat extension-manifest-integer-version
 * @removeAt 1.0.0
 */
function readCompatibilityVersion(value: unknown, field: string): string {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
        return `${value}.0.0`;
    if (typeof value === "string") {
        parseSemVer(value, field);
        return value;
    }
    throw new TypeError(
        `Extension manifest ${field} must be an x.y.z version string.`,
    );
}

function assertCompatibleVersion(
    requested: string,
    current: string,
    field: string,
): void {
    const requestedVersion = parseSemVer(requested, field);
    const currentVersion = parseSemVer(current, field);
    if (
        requestedVersion.major !== currentVersion.major ||
        compareSemVer(requestedVersion, currentVersion) > 0
    ) {
        throw new TypeError(
            `Unsupported Extension ${field}: ${requested}. Host supports ${current}.`,
        );
    }
}

interface SemVer {
    major: number;
    minor: number;
    patch: number;
}

function parseSemVer(value: string, field: string): SemVer {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
    if (match === null) {
        throw new TypeError(
            `Extension manifest ${field} must be an x.y.z version string.`,
        );
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) {
        throw new TypeError(
            `Extension manifest ${field} contains an unsafe version component.`,
        );
    }
    return { major, minor, patch };
}

function compareSemVer(left: SemVer, right: SemVer): number {
    if (left.major !== right.major) return left.major - right.major;
    if (left.minor !== right.minor) return left.minor - right.minor;
    return left.patch - right.patch;
}

function readString(value: unknown, field: string): string {
    if (typeof value === "string" && value.length > 0 && value.trim() === value)
        return value;
    throw new TypeError(
        `Extension manifest ${field} must be a non-empty trimmed string.`,
    );
}

function readLocalId(value: unknown, field: string): string {
    const id = readString(value, field);
    if (/^[a-z][a-z0-9-]*$/u.test(id)) return id;
    throw new TypeError(
        `Extension manifest ${field} must match [a-z][a-z0-9-]*.`,
    );
}

function readExtensions(
    value: unknown,
): Readonly<Record<string, readonly ExtensionPointDeclaration[]>> {
    if (value === undefined) return {};
    if (!isRecord(value))
        throw new TypeError("Extension extensions must be an object.");
    const extensions: Record<string, readonly ExtensionPointDeclaration[]> = {};
    for (const [pointId, declarations] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(pointId)) {
            throw new TypeError(`Invalid Extension Point id: ${pointId}.`);
        }
        if (!Array.isArray(declarations)) {
            throw new TypeError(
                `Extension Point ${pointId} declarations must be an array.`,
            );
        }
        const parsed = declarations.map((declaration, index) =>
            readDeclaration(declaration, pointId, index),
        );
        const ids = parsed.map((declaration) => declaration.id);
        if (new Set(ids).size !== ids.length) {
            throw new TypeError(
                `Extension Point ${pointId} declarations must not contain duplicate ids.`,
            );
        }
        extensions[pointId] = parsed;
    }
    return extensions;
}

function readDeclaration(
    value: unknown,
    pointId: string,
    index: number,
): ExtensionPointDeclaration {
    if (!isRecord(value)) {
        throw new TypeError(
            `Extension Point ${pointId} declaration ${index} must be an object.`,
        );
    }
    const id = readLocalId(value.id, `${pointId}[${index}].id`);
    const declaration: { id: string } & Record<string, ExtensionJsonValue> = {
        id,
    };
    for (const [key, candidate] of Object.entries(value)) {
        if (key === "id") continue;
        declaration[key] = cloneJsonValue(
            candidate,
            `${pointId}[${index}].${key}`,
        );
    }
    return declaration;
}

function cloneJsonValue(value: unknown, field: string): ExtensionJsonValue {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value))
        return value.map((candidate, index) =>
            cloneJsonValue(candidate, `${field}[${index}]`),
        );
    if (isRecord(value)) {
        const result: Record<string, ExtensionJsonValue> = {};
        for (const [key, candidate] of Object.entries(value))
            result[key] = cloneJsonValue(candidate, `${field}.${key}`);
        return result;
    }
    throw new TypeError(`Extension manifest ${field} must be JSON-compatible.`);
}

function readHostDependencies(
    value: unknown,
    supportsRanges: boolean,
): Readonly<Record<string, string>> {
    if (value === undefined) return {};
    if (!supportsRanges) {
        if (!Array.isArray(value))
            throw new TypeError("Extension hostDependencies must be an array.");
        const dependencies: Record<string, string> = {};
        for (const candidate of value) {
            const dependency = readHostDependencyPackage(candidate);
            if (Object.hasOwn(dependencies, dependency)) {
                throw new TypeError(
                    "Extension hostDependencies must not contain duplicates.",
                );
            }
            dependencies[dependency] = "*";
        }
        return dependencies;
    }
    if (!isRecord(value) || Array.isArray(value)) {
        throw new TypeError(
            "Extension hostDependencies must map package roots to version ranges.",
        );
    }
    const dependencies: Record<string, string> = {};
    for (const [candidate, range] of Object.entries(value)) {
        const dependency = readHostDependencyPackage(candidate);
        dependencies[dependency] = readHostDependencyRange(range, dependency);
    }
    return dependencies;
}

function readHostDependencyPackage(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.trim() !== value ||
        !isPackageRoot(value)
    ) {
        throw new TypeError(
            `Invalid Extension host dependency: ${String(value)}.`,
        );
    }
    if (value.startsWith("@portable-devshell/")) {
        throw new TypeError(
            "Extension hostDependencies must not expose portable-devshell internal packages.",
        );
    }
    return value;
}

function readHostDependencyRange(value: unknown, dependency: string): string {
    if (typeof value !== "string" || !isExtensionVersionRange(value)) {
        throw new TypeError(
            `Invalid Extension host dependency version range for ${dependency}: ${String(value)}.`,
        );
    }
    return value;
}

export function satisfiesExtensionVersionRange(
    version: string,
    range: string,
): boolean {
    const current = parseSemVer(version, "host dependency version");
    if (range === "*") return true;
    const operator = range[0] === "^" || range[0] === "~" ? range[0] : "=";
    const requested = parseSemVer(
        operator === "=" ? range : range.slice(1),
        "host dependency version range",
    );
    if (compareSemVer(current, requested) < 0) return false;
    if (operator === "=") return compareSemVer(current, requested) === 0;
    if (operator === "~")
        return current.major === requested.major && current.minor === requested.minor;
    if (requested.major > 0) return current.major === requested.major;
    if (requested.minor > 0)
        return current.major === 0 && current.minor === requested.minor;
    return (
        current.major === 0 &&
        current.minor === 0 &&
        current.patch === requested.patch
    );
}

function isExtensionVersionRange(value: string): boolean {
    if (value === "*") return true;
    const candidate = value.startsWith("^") || value.startsWith("~")
        ? value.slice(1)
        : value;
    return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(candidate);
}

function isPackageRoot(value: string): boolean {
    return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
