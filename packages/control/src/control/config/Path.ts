import type { JsonValue } from "@portable-devshell/shared";

const segmentPattern = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const domainPattern = /^[a-z][a-z0-9-]*$/u;

export interface ConfigPath {
    readonly domain: string;
    readonly relative: string;
    readonly segments: readonly string[];
}

export function parseConfigPath(path: string): ConfigPath {
    const parts = path.split(".");
    const domain = parts.shift();
    if (
        domain === undefined ||
        !domainPattern.test(domain) ||
        parts.length === 0 ||
        parts.some((segment) => !segmentPattern.test(segment))
    ) {
        throw new TypeError(`Invalid Config path: ${path}.`);
    }
    return {
        domain,
        relative: parts.join("."),
        segments: Object.freeze(parts),
    };
}

export function getConfigPathValue(
    root: unknown,
    segments: readonly string[],
): JsonValue | undefined {
    let current: unknown = root;
    for (const segment of segments) {
        if (
            typeof current !== "object" ||
            current === null ||
            Array.isArray(current) ||
            !Object.hasOwn(current, segment)
        ) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }
    return current === undefined
        ? undefined
        : (structuredClone(current) as JsonValue);
}

export function setConfigPathValue(
    root: Record<string, JsonValue>,
    segments: readonly string[],
    value: JsonValue,
): void {
    if (segments.length === 0)
        throw new TypeError("Config path must include a field segment.");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
        const existing = Object.hasOwn(current, segment)
            ? current[segment]
            : undefined;
        if (
            typeof existing !== "object" ||
            existing === null ||
            Array.isArray(existing)
        ) {
            const nested: Record<string, JsonValue> = {};
            current[segment] = nested;
            current = nested;
        } else {
            current = existing as Record<string, JsonValue>;
        }
    }
    current[segments.at(-1)!] = structuredClone(value);
}

export function diffConfigPaths(
    previous: unknown,
    next: unknown,
    prefix: string,
): string[] {
    if (deepEqual(previous, next)) return [];
    if (!isRecord(previous) || !isRecord(next)) return [prefix];
    const paths: string[] = [];
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of [...keys].sort()) {
        paths.push(
            ...diffConfigPaths(
                previous[key],
                next[key],
                `${prefix}.${key}`,
            ),
        );
    }
    return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return (
            left.length === right.length &&
            left.every((entry, index) => deepEqual(entry, right[index]))
        );
    }
    if (isRecord(left) && isRecord(right)) {
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        return (
            leftKeys.length === rightKeys.length &&
            leftKeys.every(
                (key, index) =>
                    key === rightKeys[index] &&
                    deepEqual(left[key], right[key]),
            )
        );
    }
    return false;
}
