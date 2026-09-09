import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    modelCommands,
    nativeCommands,
    type CliModelCommandBinding,
    type CliModelCommandInvocationContext,
    type CliNativeCommandBinding,
    type CliNativeCommandInvocationContext,
    type CliCommandResult
} from "@portable-devshell/extension/cli";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointValidationContext
} from "../extension/host/generation/ExtensionPointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../extension/host/generation/sandbox/ExtensionSandboxPointCodec.js";

export const cliNativeCommandsSandboxCodec: ExtensionSandboxPointCodec = Object.freeze({
    describeBinding(binding: unknown, context: ExtensionPointValidationContext): ExtensionJsonValue {
        validateCliCommandBinding(binding, context, nativeCommands.id);
        return Object.freeze({ kind: "command" });
    },
    id: nativeCommands.id,
    async invokeBinding(
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        signal: AbortSignal,
        context: ExtensionPointValidationContext
    ): Promise<unknown> {
        validateCliCommandBinding(binding, context, nativeCommands.id);
        const value = readRecord(input, `Extension ${context.extensionId} ${nativeCommands.id}/${context.id} invocation`);
        const argv = readStringArray(value.argv, "argv");
        const invocation = readRecord(value.context, "native CLI invocation context");
        return await (binding as CliNativeCommandBinding)(argv, Object.freeze({
            localOwner: readBoolean(invocation.localOwner, "localOwner"),
            requestId: readString(invocation.requestId, "requestId"),
            signal,
            ...(invocation.workingDirectory === undefined
                ? {}
                : { workingDirectory: readString(invocation.workingDirectory, "workingDirectory") })
        }));
    }
});

export const cliModelCommandsSandboxCodec: ExtensionSandboxPointCodec = Object.freeze({
    describeBinding(binding: unknown, context: ExtensionPointValidationContext): ExtensionJsonValue {
        validateCliCommandBinding(binding, context, modelCommands.id);
        return Object.freeze({ kind: "command" });
    },
    id: modelCommands.id,
    async invokeBinding(
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        signal: AbortSignal,
        context: ExtensionPointValidationContext
    ): Promise<unknown> {
        validateCliCommandBinding(binding, context, modelCommands.id);
        const value = readRecord(input, `Extension ${context.extensionId} ${modelCommands.id}/${context.id} invocation`);
        const argv = readStringArray(value.argv, "argv");
        const invocation = readRecord(value.context, "model CLI invocation context");
        return await (binding as CliModelCommandBinding)(argv, Object.freeze({
            requestId: readString(invocation.requestId, "requestId"),
            signal
        }));
    }
});

export function createCliNativeSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge
): CliNativeCommandBinding {
    assertCommandDescriptor(descriptor, context, nativeCommands.id);
    return async (argv: readonly string[], invocation: CliNativeCommandInvocationContext): Promise<CliCommandResult> =>
        await bridge.invokeBinding(nativeCommands.id, context.id, {
            argv: [...argv],
            context: {
                localOwner: invocation.localOwner,
                requestId: invocation.requestId,
                ...(invocation.workingDirectory === undefined
                    ? {}
                    : { workingDirectory: invocation.workingDirectory })
            }
        }, { signal: invocation.signal }) as CliCommandResult;
}

export function createCliModelSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge
): CliModelCommandBinding {
    assertCommandDescriptor(descriptor, context, modelCommands.id);
    return async (argv: readonly string[], invocation: CliModelCommandInvocationContext): Promise<CliCommandResult> =>
        await bridge.invokeBinding(modelCommands.id, context.id, {
            argv: [...argv],
            context: { requestId: invocation.requestId }
        }, { signal: invocation.signal }) as CliCommandResult;
}

export function validateCliCommandBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
    pointId: string
): asserts binding is CliNativeCommandBinding | CliModelCommandBinding {
    if (typeof binding !== "function") {
        throw new TypeError(
            `Extension ${context.extensionId} ${pointId}/${context.id} binding must be a function.`
        );
    }
}

function assertCommandDescriptor(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    pointId: string
): void {
    const value = readRecord(descriptor, `Extension ${context.extensionId} ${pointId}/${context.id} sandbox descriptor`);
    if (value.kind !== "command" || Object.keys(value).some((key) => key !== "kind")) {
        throw new TypeError(`Extension ${context.extensionId} ${pointId}/${context.id} sandbox descriptor is invalid.`);
    }
}

function readRecord(value: unknown, label: string): Record<string, ExtensionJsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, ExtensionJsonValue>;
    }
    throw new TypeError(`${label} must be an object.`);
}

function readStringArray(value: ExtensionJsonValue | undefined, field: string): string[] {
    if (Array.isArray(value) && value.every((candidate) => typeof candidate === "string")) {
        return [...value] as string[];
    }
    throw new TypeError(`CLI sandbox ${field} must be an array of strings.`);
}

function readString(value: ExtensionJsonValue | undefined, field: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`CLI sandbox ${field} must be a non-empty string.`);
}

function readBoolean(value: ExtensionJsonValue | undefined, field: string): boolean {
    if (typeof value === "boolean") return value;
    throw new TypeError(`CLI sandbox ${field} must be boolean.`);
}
