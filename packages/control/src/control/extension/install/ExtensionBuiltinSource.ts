import { isAbsolute } from "node:path";

export const CONTROL_BUILTIN_EXTENSION_SOURCES_ENV = "PORTABLE_DEVSHELL_BUILTIN_EXTENSION_SOURCES";

export interface BuiltinExtensionSource {
    id: string;
    path: string;
}

export function readBuiltinExtensionSources(
    env: NodeJS.ProcessEnv = process.env
): readonly BuiltinExtensionSource[] {
    const raw = env[CONTROL_BUILTIN_EXTENSION_SOURCES_ENV];
    if (raw === undefined || raw.length === 0) return Object.freeze([]);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} must contain a JSON array.`, { cause: error });
    }
    if (!Array.isArray(parsed)) {
        throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} must contain a JSON array.`);
    }
    const seen = new Set<string>();
    const sources: BuiltinExtensionSource[] = [];
    for (const value of parsed) {
        if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string") {
            throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} entries must contain id and path strings.`);
        }
        if (!/^[a-z][a-z0-9-]*$/u.test(value.id)) {
            throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} contains an invalid Extension id.`);
        }
        if (!isAbsolute(value.path)) {
            throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} paths must be absolute.`);
        }
        if (seen.has(value.id)) {
            throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} contains duplicate id ${value.id}.`);
        }
        seen.add(value.id);
        sources.push(Object.freeze({ id: value.id, path: value.path }));
    }
    return Object.freeze(sources);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
