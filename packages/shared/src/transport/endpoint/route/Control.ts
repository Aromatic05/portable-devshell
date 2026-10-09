// Shared route-definition vocabulary used by provider-side host/port routing.
// Request and response semantics stay in the owning domain Contract.

import { controlErrorCodes } from "../../../types/Error.js";
import { createRemoteError } from "../../Error.js";

import type { ControlClientKind } from "../../../control/server/Model.js";
import type { JsonValue } from "../../../types/Json.js";
import type { MessageStream } from "../../packet/Stream.js";

export interface ControlPeerSubject {
    readonly id: string;
    readonly kind: string;
}

export interface ControlPortRequest {
    readonly id: string;
    readonly name: string;
    readonly payload?: JsonValue;
}

export interface ControlPortContext {
    readonly connectionId: string;
    readonly host: string;
    readonly peer: ControlClientKind;
    readonly sourceHost: string;
    readonly protocolVersion?: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly subject?: ControlPeerSubject;
    afterReply(action: () => Promise<void> | void): void;
}

export interface ControlStreamMessage {
    readonly name: string;
    readonly payload?: JsonValue;
    readonly seq?: number;
}

export type ControlPortHandler = (
    request: ControlPortRequest,
    context: ControlPortContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export type ControlPortStreamHandler = (
    stream: MessageStream,
    request: ControlPortRequest,
    context: ControlPortContext,
) => Promise<void> | void;

export interface ControlPortDefinition {
    readonly name: string;
    readonly operations: readonly {
        readonly name: string;
        readonly handle: ControlPortHandler;
    }[];
    readonly streams?: readonly {
        readonly name: string;
        readonly handle: ControlPortStreamHandler;
    }[];
}

export interface ControlHostDefinition {
    readonly host: string;
    readonly ports: readonly ControlPortDefinition[];
}

export function mergeControlPorts(
    ...ports: readonly ControlPortDefinition[]
): ControlPortDefinition {
    const first = ports[0];
    if (first === undefined)
        throw new Error("Cannot merge an empty port list.");
    if (ports.some((port) => port.name !== first.name))
        throw new Error("Cannot merge ports with different names.");
    const operations = ports.flatMap((port) => port.operations);
    const streams = ports.flatMap((port) => port.streams ?? []);
    const names = new Set<string>();
    for (const operation of [...operations, ...streams]) {
        if (names.has(operation.name))
            throw new Error(
                `Duplicate ${first.name} operation: ${operation.name}`,
            );
        names.add(operation.name);
    }
    return {
        name: first.name,
        operations,
        ...(streams.length === 0 ? {} : { streams }),
    };
}

export function mergeControlPortsByName(
    ports: readonly ControlPortDefinition[],
): ControlPortDefinition[] {
    const groups = new Map<string, ControlPortDefinition[]>();
    for (const port of ports) {
        const group = groups.get(port.name) ?? [];
        group.push(port);
        groups.set(port.name, group);
    }
    return [...groups.values()].map((group) => mergeControlPorts(...group));
}

export function routeModule(
    name: string,
    operations: Record<string, ControlPortHandler>,
    streams: Record<string, ControlPortStreamHandler> = {},
): ControlPortDefinition {
    return {
        name,
        operations: Object.entries(operations).map(([operation, handle]) => ({
            name: operation,
            handle,
        })),
        ...(Object.keys(streams).length === 0
            ? {}
            : {
                  streams: Object.entries(streams).map(
                      ([operation, handle]) => ({
                          name: operation,
                          handle,
                      }),
                  ),
              }),
    };
}

export function requirePort<T>(port: T | undefined, message: string): T {
    if (port !== undefined) return port;
    throw createRemoteError({
        code: controlErrorCodes.methodNotFound,
        message,
        retryable: false,
    });
}
