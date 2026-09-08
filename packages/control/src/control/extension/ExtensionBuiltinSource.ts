import { isAbsolute } from "node:path";

export const CONTROL_BUILTIN_EXTENSION_SOURCES_ENV = "PORTABLE_DEVSHELL_BUILTIN_EXTENSION_SOURCES";

export function readBuiltinExtensionSources(
    env: NodeJS.ProcessEnv = process.env
): readonly string[] {
    const raw = env[CONTROL_BUILTIN_EXTENSION_SOURCES_ENV];
    if (raw === undefined || raw.length === 0) return Object.freeze([]);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} must contain a JSON array.`, { cause: error });
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !isAbsolute(value))) {
        throw new TypeError(`${CONTROL_BUILTIN_EXTENSION_SOURCES_ENV} must contain only absolute paths.`);
    }
    return Object.freeze([...new Set(parsed)]);
}
