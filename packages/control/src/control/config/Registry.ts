import type { JsonValue } from "@portable-devshell/shared";
import { Check, type XSchema } from "typebox/schema";

export type ConfigDomainOwner =
    | { readonly kind: "core" }
    | {
          readonly extensionId: string;
          readonly generation: string;
          readonly kind: "extension";
      };

export type ConfigPathPermission = "read" | "read-write";

export interface ConfigDomainDefinition {
    readonly defaultValue?: Readonly<Record<string, JsonValue>>;
    readonly exports?: Readonly<Record<string, ConfigPathPermission>>;
    readonly id: string;
    readonly owner: ConfigDomainOwner;
    readonly schema?: boolean | Readonly<Record<string, JsonValue>>;
}

export class ConfigRegistry {
    readonly #domains = new Map<string, ConfigDomainDefinition>();

    constructor(definitions: readonly ConfigDomainDefinition[] = []) {
        for (const definition of definitions) this.register(definition);
    }

    register(definition: ConfigDomainDefinition): void {
        const normalized = normalizeConfigDomainDefinition(definition);
        const existing = this.#domains.get(definition.id);
        if (existing !== undefined) {
            throw new Error(
                `Config domain ${definition.id} is already registered by ${formatOwner(existing.owner)}.`,
            );
        }
        this.#domains.set(definition.id, normalized);
    }

    assertCanReplace(definition: ConfigDomainDefinition): void {
        const normalized = normalizeConfigDomainDefinition(definition);
        const existing = this.#domains.get(normalized.id);
        if (
            existing !== undefined &&
            !sameConfigOwnerIdentity(existing.owner, normalized.owner)
        ) {
            throw new Error(
                `Config domain ${normalized.id} is already registered by ${formatOwner(existing.owner)}.`,
            );
        }
    }

    replace(definition: ConfigDomainDefinition): void {
        const normalized = normalizeConfigDomainDefinition(definition);
        const existing = this.#domains.get(normalized.id);
        if (
            existing !== undefined &&
            !sameConfigOwnerIdentity(existing.owner, normalized.owner)
        ) {
            throw new Error(
                `Config domain ${normalized.id} is already registered by ${formatOwner(existing.owner)}.`,
            );
        }
        this.#domains.set(normalized.id, normalized);
    }

    remove(id: string, owner?: ConfigDomainOwner): void {
        const existing = this.#domains.get(id);
        if (existing === undefined) return;
        if (owner !== undefined && !sameConfigOwner(existing.owner, owner)) {
            throw new Error(
                `Config domain ${id} is registered by ${formatOwner(existing.owner)}, not ${formatOwner(owner)}.`,
            );
        }
        if (existing.owner.kind === "core") {
            throw new Error(`Core Config domain ${id} cannot be removed.`);
        }
        this.#domains.delete(id);
    }

    get(id: string): ConfigDomainDefinition | undefined {
        return this.#domains.get(id);
    }

    has(id: string): boolean {
        return this.#domains.has(id);
    }

    list(): readonly ConfigDomainDefinition[] {
        return Object.freeze(
            [...this.#domains.values()].sort((left, right) =>
                left.id.localeCompare(right.id),
            ),
        );
    }

    require(id: string): ConfigDomainDefinition {
        const definition = this.#domains.get(id);
        if (definition !== undefined) return definition;
        throw new Error(`Config domain ${id} is not registered.`);
    }
}

export function createCoreConfigRegistry(): ConfigRegistry {
    return new ConfigRegistry([
        {
            exports: {
                artifactDirectTransfer: "read",
                logLevel: "read",
            },
            id: "control",
            owner: { kind: "core" },
        },
        {
            exports: {
                enabled: "read",
                listenHost: "read",
                listenPort: "read",
                publicBaseUrl: "read-write",
            },
            id: "mcp",
            owner: { kind: "core" },
        },
        {
            exports: {
                enabled: "read",
                listenHost: "read",
                listenPort: "read",
                publicBaseUrl: "read-write",
            },
            id: "web",
            owner: { kind: "core" },
        },
    ]);
}

function assertDomainId(id: string): void {
    if (/^[a-z][a-z0-9-]*$/u.test(id)) return;
    throw new TypeError(
        `Config domain id ${JSON.stringify(id)} must match [a-z][a-z0-9-]*.`,
    );
}

function formatOwner(owner: ConfigDomainOwner): string {
    return owner.kind === "core"
        ? "core"
        : `extension:${owner.extensionId}@${owner.generation}`;
}

export function normalizeConfigDomainDefinition(
    definition: ConfigDomainDefinition,
): ConfigDomainDefinition {
    assertDomainId(definition.id);
    if (definition.owner.kind === "extension") {
        assertDomainId(definition.owner.extensionId);
        if (
            definition.owner.generation.length === 0 ||
            definition.owner.generation.trim() !== definition.owner.generation
        ) {
            throw new TypeError(
                "Extension Config domain generation must be a non-empty trimmed string.",
            );
        }
    }
    const exportedPaths = normalizeExports(definition.id, definition.exports);
    if (
        (definition.schema === undefined) !==
        (definition.defaultValue === undefined)
    ) {
        throw new TypeError(
            `Config domain ${definition.id} must declare schema and defaultValue together.`,
        );
    }
    if (definition.schema !== undefined) {
        if (
            typeof definition.schema !== "boolean" &&
            !isJsonRecord(definition.schema)
        ) {
            throw new TypeError(
                `Config domain ${definition.id} schema must be a JSON Schema object or boolean.`,
            );
        }
        if (!isJsonRecord(definition.defaultValue)) {
            throw new TypeError(
                `Config domain ${definition.id} defaultValue must be a JSON object.`,
            );
        }
        assertSchemaValue(
            definition.id,
            definition.schema,
            definition.defaultValue,
            "defaultValue",
        );
    }
    const defaultValue =
        definition.defaultValue === undefined
            ? undefined
            : structuredClone(definition.defaultValue);
    const schema =
        definition.schema === undefined
            ? undefined
            : structuredClone(definition.schema);
    return Object.freeze({
        ...(defaultValue === undefined
            ? {}
            : { defaultValue: deepFreezeJsonRecord(defaultValue) }),
        ...(exportedPaths === undefined ? {} : { exports: exportedPaths }),
        id: definition.id,
        owner: Object.freeze({ ...definition.owner }),
        ...(schema === undefined
            ? {}
            : { schema: deepFreezeJsonSchema(schema) }),
    });
}

function normalizeExports(
    id: string,
    exports: ConfigDomainDefinition["exports"],
): Readonly<Record<string, ConfigPathPermission>> | undefined {
    if (exports === undefined) return undefined;
    const normalized: Record<string, ConfigPathPermission> = {};
    for (const [path, permission] of Object.entries(exports)) {
        if (
            !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(
                path,
            )
        ) {
            throw new TypeError(
                `Config domain ${id} export path ${path} is invalid.`,
            );
        }
        if (permission !== "read" && permission !== "read-write") {
            throw new TypeError(
                `Config domain ${id} export ${path} has an invalid permission.`,
            );
        }
        normalized[path] = permission;
    }
    return Object.freeze(normalized);
}

export function assertConfigDomainValue(
    definition: ConfigDomainDefinition,
    value: unknown,
): asserts value is Readonly<Record<string, JsonValue>> {
    if (definition.schema === undefined) {
        throw new Error(
            `Config domain ${definition.id} does not declare a schema.`,
        );
    }
    if (!isJsonRecord(value)) {
        throw new TypeError(
            `Config domain ${definition.id} value must be a JSON object.`,
        );
    }
    assertSchemaValue(definition.id, definition.schema, value, "value");
}

export function sameConfigOwner(
    left: ConfigDomainOwner,
    right: ConfigDomainOwner,
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "core" || right.kind === "core") return true;
    return (
        left.extensionId === right.extensionId &&
        left.generation === right.generation
    );
}

function sameConfigOwnerIdentity(
    left: ConfigDomainOwner,
    right: ConfigDomainOwner,
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "core" || right.kind === "core") return true;
    return left.extensionId === right.extensionId;
}

function assertSchemaValue(
    id: string,
    schema: boolean | Readonly<Record<string, JsonValue>>,
    value: Readonly<Record<string, JsonValue>>,
    label: string,
): void {
    let valid: boolean;
    try {
        valid = Check(schema as XSchema, value);
    } catch (error) {
        throw new TypeError(`Config domain ${id} schema is invalid.`, {
            cause: error,
        });
    }
    if (!valid) {
        throw new TypeError(
            `Config domain ${id} ${label} does not match its declared schema.`,
        );
    }
}

function isJsonRecord(
    value: unknown,
): value is Readonly<Record<string, JsonValue>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeJsonRecord(
    value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
    return deepFreezeJsonValue(value) as Readonly<Record<string, JsonValue>>;
}

function deepFreezeJsonSchema(
    value: boolean | Readonly<Record<string, JsonValue>>,
): boolean | Readonly<Record<string, JsonValue>> {
    return typeof value === "boolean" ? value : deepFreezeJsonRecord(value);
}

function deepFreezeJsonValue(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const entry of value) deepFreezeJsonValue(entry);
        return Object.freeze(value) as unknown as JsonValue;
    }
    if (typeof value === "object" && value !== null) {
        for (const entry of Object.values(value)) deepFreezeJsonValue(entry);
        return Object.freeze(value);
    }
    return value;
}
