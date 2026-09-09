import type {
    ExtensionInvocationContext,
    ExtensionJsonValue
} from "@portable-devshell/extension";
import {
    commands,
    type CliCommandBinding,
    type CliCommandResult
} from "@portable-devshell/extension/cli";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointValidationContext
} from "../extension/host/generation/ExtensionPointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../extension/host/generation/sandbox/ExtensionSandboxPointCodec.js";

export const cliCommandsSandboxCodec: ExtensionSandboxPointCodec = Object.freeze({
    describeBinding(binding: unknown, context: ExtensionPointValidationContext): ExtensionJsonValue {
        validateCliCommandBinding(binding, context);
        return Object.freeze({ kind: "command" });
    },
    id: commands.id,
    async invokeBinding(
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        signal: AbortSignal,
        context: ExtensionPointValidationContext
    ): Promise<unknown> {
        validateCliCommandBinding(binding, context);
        const value = readRecord(input, `Extension ${context.extensionId} cli.commands/${context.id} invocation`);
        const argv = readStringArray(value.argv, "argv");
        const invocation = readRecord(value.context, "CLI invocation context");
        return await (binding as CliCommandBinding)(argv, Object.freeze({
            localOwner: readBoolean(invocation.localOwner, "localOwner"),
            requestId: readString(invocation.requestId, "requestId"),
            signal,
            ...(invocation.workingDirectory === undefined
                ? {}
                : { workingDirectory: readString(invocation.workingDirectory, "workingDirectory") })
        }));
    }
});

export function createCliSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge
): CliCommandBinding {
    const value = readRecord(
        descriptor,
        `Extension ${context.extensionId} cli.commands/${context.id} sandbox descriptor`
    );
    if (value.kind !== "command" || Object.keys(value).some((key) => key !== "kind")) {
        throw new TypeError(`Extension ${context.extensionId} cli.commands/${context.id} sandbox descriptor is invalid.`);
    }
    return async (argv: readonly string[], invocation: ExtensionInvocationContext): Promise<CliCommandResult> =>
        await bridge.invokeBinding(commands.id, context.id, {
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

export function validateCliCommandBinding(
    binding: unknown,
    context: ExtensionPointValidationContext
): asserts binding is CliCommandBinding {
    if (typeof binding !== "function") {
        throw new TypeError(
            `Extension ${context.extensionId} cli.commands/${context.id} binding must be a function.`
        );
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
