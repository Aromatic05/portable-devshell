import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    pages,
    type TuiPageBinding,
    type TuiPageRequest,
    type TuiPageSnapshot,
} from "@portable-devshell/extension/tui";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointSandboxInvocationContext,
    ExtensionPointValidationContext,
} from "../generation/registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../generation/sandbox/bridge/PointCodec.js";

export const tuiPagesSandboxCodec: ExtensionSandboxPointCodec = Object.freeze({
    describeBinding(
        binding: unknown,
        context: ExtensionPointValidationContext,
    ): ExtensionJsonValue {
        validateTuiPageBinding(binding, context);
        return Object.freeze({ kind: "page" });
    },
    id: pages.id,
    async invokeBinding(
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        signal: AbortSignal,
        context: ExtensionPointSandboxInvocationContext,
    ): Promise<unknown> {
        validateTuiPageBinding(binding, context);
        const value = readRecord(input, "TUI page invocation");
        const request = readRequest(value.request);
        const invocation = readRecord(value.context, "TUI page invocation context");
        return await (binding as TuiPageBinding)(request, {
            localOwner: readBoolean(invocation.localOwner, "localOwner"),
            requestId: readString(invocation.requestId, "requestId"),
            signal,
        });
    },
});

export function createTuiPageSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): TuiPageBinding {
    const value = readRecord(
        descriptor,
        `Extension ${context.extensionId} tui.pages/${context.id} sandbox descriptor`,
    );
    if (
        value.kind !== "page" ||
        Object.keys(value).some((key) => key !== "kind")
    ) {
        throw new TypeError(
            `Extension ${context.extensionId} tui.pages/${context.id} sandbox descriptor is invalid.`,
        );
    }
    return async (request, invocation) =>
        (await bridge.invokeBinding(
            pages.id,
            context.id,
            {
                context: {
                    localOwner: invocation.localOwner,
                    requestId: invocation.requestId,
                },
                request: request as unknown as ExtensionJsonValue,
            },
            { signal: invocation.signal, timeoutLabel: "TUI page invocation" },
        )) as TuiPageSnapshot;
}

export function validateTuiPageBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is TuiPageBinding {
    if (typeof binding !== "function") {
        throw new TypeError(
            `Extension ${context.extensionId} tui.pages/${context.id} binding must be a function.`,
        );
    }
}

function readRequest(value: ExtensionJsonValue | undefined): TuiPageRequest {
    const record = readRecord(value, "TUI page request");
    if (
        record.kind === "read" &&
        Object.keys(record).every((key) => key === "kind")
    )
        return { kind: "read" };
    if (record.kind === "action") {
        const allowed = new Set(["actionId", "itemId", "kind"]);
        if (Object.keys(record).some((key) => !allowed.has(key)))
            throw new TypeError("TUI page action request contains unknown fields.");
        return {
            actionId: readString(record.actionId, "actionId"),
            ...(record.itemId === undefined
                ? {}
                : { itemId: readString(record.itemId, "itemId") }),
            kind: "action",
        };
    }
    throw new TypeError("TUI page request kind is invalid.");
}

function readRecord(
    value: ExtensionJsonValue | undefined,
    label: string,
): Record<string, ExtensionJsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value as Record<string, ExtensionJsonValue>;
    throw new TypeError(`${label} must be an object.`);
}

function readString(value: ExtensionJsonValue | undefined, label: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`${label} must be a non-empty string.`);
}

function readBoolean(value: ExtensionJsonValue | undefined, label: string): boolean {
    if (typeof value === "boolean") return value;
    throw new TypeError(`${label} must be boolean.`);
}
