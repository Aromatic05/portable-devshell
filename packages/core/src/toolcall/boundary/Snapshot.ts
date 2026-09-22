import type { JsonValue } from "@portable-devshell/shared";

export function snapshotJson(value: JsonValue): JsonValue {
    return freezeJson(cloneJson(value));
}

function cloneJson(value: JsonValue): JsonValue {
    if (!isJsonContainer(value)) return value;

    const root = createJsonContainer(value);
    const clones = new Map<object, JsonContainer>([[value, root]]);
    const stack: Array<{ source: JsonContainer; target: JsonContainer }> = [
        { source: value, target: root },
    ];
    while (stack.length > 0) {
        const frame = stack.pop()!;
        if (Array.isArray(frame.source)) {
            const target = frame.target as JsonValue[];
            for (let index = 0; index < frame.source.length; index += 1) {
                const child = frame.source[index] as JsonValue;
                target[index] = cloneJsonChild(child, clones, stack);
            }
            continue;
        }
        const target = frame.target as Record<string, JsonValue>;
        for (const [key, child] of Object.entries(frame.source))
            defineJsonProperty(target, key, cloneJsonChild(child, clones, stack));
    }
    return root;
}

function freezeJson(value: JsonValue): JsonValue {
    if (!isJsonContainer(value)) return value;
    const seen = new Set<object>();
    const stack: JsonContainer[] = [value];
    const containers: JsonContainer[] = [];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        containers.push(current);
        for (const child of Object.values(current)) {
            if (isJsonContainer(child)) stack.push(child);
        }
    }
    for (let index = containers.length - 1; index >= 0; index -= 1)
        Object.freeze(containers[index]);
    return value;
}

type JsonContainer = JsonValue[] | Record<string, JsonValue>;

function isJsonContainer(value: JsonValue): value is JsonContainer {
    return typeof value === "object" && value !== null;
}

function createJsonContainer(value: JsonContainer): JsonContainer {
    return Array.isArray(value) ? new Array<JsonValue>(value.length) : {};
}

function cloneJsonChild(
    value: JsonValue,
    clones: Map<object, JsonContainer>,
    stack: Array<{ source: JsonContainer; target: JsonContainer }>,
): JsonValue {
    if (!isJsonContainer(value)) return value;
    const existing = clones.get(value);
    if (existing !== undefined) return existing;
    const cloned = createJsonContainer(value);
    clones.set(value, cloned);
    stack.push({ source: value, target: cloned });
    return cloned;
}

function defineJsonProperty(
    target: Record<string, JsonValue>,
    key: string,
    value: JsonValue,
): void {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}
