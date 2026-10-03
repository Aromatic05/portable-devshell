import {
    routes,
    type ControlRouteBinding,
    type ControlRouteInvocationContext,
    type ControlRouteRequest,
} from "@portable-devshell/extension/control";
import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointSandboxInvocationContext,
    ExtensionPointValidationContext,
} from "../../../registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../../../sandbox/bridge/PointCodec.js";

export const controlRoutesSandboxCodec: ExtensionSandboxPointCodec =
    Object.freeze({
        describeBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ): ExtensionJsonValue {
            validateControlRouteBinding(binding, context);
            return Object.freeze({ kind: "route" });
        },
        id: routes.id,
        async invokeBinding(
            binding: unknown,
            input: ExtensionJsonValue | undefined,
            signal: AbortSignal,
            context: ExtensionPointSandboxInvocationContext,
        ): Promise<unknown> {
            validateControlRouteBinding(binding, context);
            const value = readExtensionRecord(
                input,
                "Control route invocation",
            );
            const request = readControlRouteRequest(value.request);
            const invocation = readExtensionRecord(
                value.context,
                "Control route invocation context",
            );
            return await (binding as ControlRouteBinding)(
                request,
                Object.freeze({
                    destination: readExtensionString(
                        invocation.destination,
                        "destination",
                    ),
                    peer: readRoutePeer(invocation.peer),
                    ...(invocation.protocolVersion === undefined
                        ? {}
                        : {
                              protocolVersion: readExtensionString(
                                  invocation.protocolVersion,
                                  "protocolVersion",
                              ),
                          }),
                    requestId: readExtensionString(
                        invocation.requestId,
                        "requestId",
                    ),
                    signal,
                    ...(invocation.subject === undefined
                        ? {}
                        : { subject: readRouteSubject(invocation.subject) }),
                }),
            );
        },
    });

export function createControlRouteSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): ControlRouteBinding {
    const value = readExtensionRecord(
        descriptor,
        `Extension ${context.extensionId} control.routes/${context.id} sandbox descriptor`,
    );
    if (
        value.kind !== "route" ||
        Object.keys(value).some((key) => key !== "kind")
    ) {
        throw new TypeError(
            `Extension ${context.extensionId} control.routes/${context.id} sandbox descriptor is invalid.`,
        );
    }
    return async (request, invocation) =>
        (await bridge.invokeBinding(
            routes.id,
            context.id,
            {
                context: {
                    destination: invocation.destination,
                    peer: invocation.peer,
                    ...(invocation.protocolVersion === undefined
                        ? {}
                        : { protocolVersion: invocation.protocolVersion }),
                    requestId: invocation.requestId,
                    ...(invocation.subject === undefined
                        ? {}
                        : { subject: { ...invocation.subject } }),
                },
                request: request as unknown as ExtensionJsonValue,
            },
            {
                signal: invocation.signal,
                timeoutLabel: "Control route invocation",
            },
        )) as ExtensionJsonValue | undefined;
}

export function validateControlRouteBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is ControlRouteBinding {
    if (typeof binding !== "function") {
        throw new TypeError(
            `Extension ${context.extensionId} control.routes/${context.id} binding must be a function.`,
        );
    }
}

function readControlRouteRequest(
    value: ExtensionJsonValue | undefined,
): ControlRouteRequest {
    const record = readExtensionRecord(value, "Control route request");
    const unknown = Object.keys(record).find(
        (key) => key !== "payload" && key !== "seq",
    );
    if (unknown !== undefined) {
        throw new TypeError(
            `Control route request contains unknown field ${unknown}.`,
        );
    }
    if (
        record.seq !== undefined &&
        (typeof record.seq !== "number" ||
            !Number.isSafeInteger(record.seq) ||
            record.seq < 0)
    ) {
        throw new TypeError(
            "Control route request seq must be a non-negative integer.",
        );
    }
    return Object.freeze({
        ...(record.payload === undefined ? {} : { payload: record.payload }),
        ...(record.seq === undefined ? {} : { seq: record.seq }),
    });
}

function readRoutePeer(
    value: ExtensionJsonValue | undefined,
): ControlRouteInvocationContext["peer"] {
    if (value === "cli" || value === "tui" || value === "web") return value;
    throw new TypeError("Control route peer is invalid.");
}

function readRouteSubject(
    value: ExtensionJsonValue,
): NonNullable<ControlRouteInvocationContext["subject"]> {
    const record = readExtensionRecord(value, "Control route subject");
    return Object.freeze({
        id: readExtensionString(record.id, "subject.id"),
        kind: readExtensionString(record.kind, "subject.kind"),
    });
}

function readExtensionRecord(
    value: ExtensionJsonValue | undefined,
    label: string,
): Record<string, ExtensionJsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, ExtensionJsonValue>;
    }
    throw new TypeError(`${label} must be an object.`);
}

function readExtensionString(
    value: ExtensionJsonValue | undefined,
    label: string,
): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`${label} must be a non-empty string.`);
}
