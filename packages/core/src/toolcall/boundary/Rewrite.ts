import type { JsonValue } from "@portable-devshell/shared";

import type {
    ToolCallBoundaryContext,
    ToolCallBoundaryDirection,
    ToolCallBoundaryPayloadKind,
} from "./Review.js";

export type ToolCallRewritePath = readonly (number | string)[];

export interface ToolCallRewriteInput {
    readonly context: ToolCallBoundaryContext;
    readonly direction: ToolCallBoundaryDirection;
    readonly kind: ToolCallBoundaryPayloadKind;
    readonly path: ToolCallRewritePath;
    readonly signal: AbortSignal;
    readonly text: string;
    readonly toolName: string;
}

export type ToolCallRewrite = (
    input: ToolCallRewriteInput,
) => Promise<string> | string;

export interface ToolCallRewritePayloadInput {
    readonly context: ToolCallBoundaryContext;
    readonly direction: ToolCallBoundaryDirection;
    readonly kind: ToolCallBoundaryPayloadKind;
    readonly payload: JsonValue;
    readonly signal: AbortSignal;
    readonly toolName: string;
}

export async function rewriteToolCallPayload(
    rewrites: readonly ToolCallRewrite[],
    input: ToolCallRewritePayloadInput,
): Promise<JsonValue> {
    const rewritesInOrder =
        input.direction === "inbound" ? rewrites : [...rewrites].reverse();
    const seen = new Map<object, JsonContainer>();
    const frames: RewriteFrame[] = [{ source: input.payload }];
    let result: JsonValue = null;

    while (frames.length > 0) {
        const frame = frames.pop()!;
        if (typeof frame.source === "string") {
            let text = frame.source;
            for (const rewrite of rewritesInOrder) {
                const next = await rewrite(
                    Object.freeze({
                        context: input.context,
                        direction: input.direction,
                        kind: input.kind,
                        path: materializePath(frame.path),
                        signal: input.signal,
                        text,
                        toolName: input.toolName,
                    }),
                );
                if (typeof next !== "string")
                    throw new TypeError("ToolCall rewrite must return a string.");
                text = next;
            }
            result = assignJson(frame, text, result);
            continue;
        }
        if (!isJsonContainer(frame.source)) {
            result = assignJson(frame, frame.source, result);
            continue;
        }

        const existing = seen.get(frame.source);
        if (existing !== undefined) {
            result = assignJson(frame, existing, result);
            continue;
        }
        const target = createJsonContainer(frame.source);
        seen.set(frame.source, target);
        result = assignJson(frame, target, result);

        if (Array.isArray(frame.source)) {
            for (let index = frame.source.length - 1; index >= 0; index -= 1) {
                frames.push({
                    key: index,
                    parent: target,
                    path: extendPath(frame.path, index),
                    source: frame.source[index] as JsonValue,
                });
            }
            continue;
        }
        const entries = Object.entries(frame.source);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const [key, child] = entries[index]!;
            frames.push({
                key,
                parent: target,
                path: extendPath(frame.path, key),
                source: child,
            });
        }
    }
    return result;
}

type JsonContainer = JsonValue[] | Record<string, JsonValue>;

interface RewritePathNode {
    readonly depth: number;
    readonly parent?: RewritePathNode;
    readonly segment: number | string;
}

interface RewriteFrame {
    readonly key?: number | string;
    readonly parent?: JsonContainer;
    readonly path?: RewritePathNode;
    readonly source: JsonValue;
}

function isJsonContainer(value: JsonValue): value is JsonContainer {
    return typeof value === "object" && value !== null;
}

function createJsonContainer(value: JsonContainer): JsonContainer {
    return Array.isArray(value) ? new Array<JsonValue>(value.length) : {};
}

function extendPath(
    parent: RewritePathNode | undefined,
    segment: number | string,
): RewritePathNode {
    return {
        depth: (parent?.depth ?? 0) + 1,
        ...(parent === undefined ? {} : { parent }),
        segment,
    };
}

function materializePath(node: RewritePathNode | undefined): ToolCallRewritePath {
    const path: Array<number | string> = new Array(node?.depth ?? 0);
    let current = node;
    while (current !== undefined) {
        path[current.depth - 1] = current.segment;
        current = current.parent;
    }
    return Object.freeze(path);
}

function assignJson(
    frame: RewriteFrame,
    value: JsonValue,
    root: JsonValue,
): JsonValue {
    if (frame.parent === undefined) return value;
    if (Array.isArray(frame.parent)) {
        frame.parent[frame.key as number] = value;
        return root;
    }
    Object.defineProperty(frame.parent, frame.key as string, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
    return root;
}
