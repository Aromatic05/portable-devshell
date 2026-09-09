import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    applications,
    type WebApplicationBinding
} from "@portable-devshell/extension/web";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointValidationContext
} from "../../../control/extension/host/generation/ExtensionPointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../../../control/extension/host/generation/sandbox/ExtensionSandboxPointCodec.js";

export const webApplicationsSandboxCodec: ExtensionSandboxPointCodec = Object.freeze({
    describeBinding(binding: unknown, context: ExtensionPointValidationContext): ExtensionJsonValue {
        validateWebApplicationBinding(binding, context);
        if (binding.source.kind === "files") {
            return Object.freeze({ directory: binding.source.directory, kind: "files" });
        }
        return Object.freeze({ kind: "endpoint" });
    },
    id: applications.id,
    async invokeBinding(
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        _signal: AbortSignal,
        context: ExtensionPointValidationContext
    ): Promise<unknown> {
        validateWebApplicationBinding(binding, context);
        if (input !== undefined) {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} sandbox invocation takes no input.`
            );
        }
        if (binding.source.kind !== "endpoint") {
            throw new TypeError(`Extension Web application ${context.id} is not endpoint-backed.`);
        }
        const upstream = await binding.source.resolve();
        if (upstream !== undefined && !(upstream instanceof URL)) {
            throw new TypeError("Extension Web application endpoint resolve() must return a URL or undefined.");
        }
        return upstream?.href;
    }
});

export function createWebApplicationSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge
): WebApplicationBinding {
    const value = readRecord(
        descriptor,
        `Extension ${context.extensionId} web.applications/${context.id} sandbox descriptor`
    );
    if (value.kind === "files") {
        if (Object.keys(value).some((key) => key !== "directory" && key !== "kind")) {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} files descriptor has unknown fields.`
            );
        }
        if (typeof value.directory !== "string" || value.directory.length === 0) {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} files descriptor directory is invalid.`
            );
        }
        return Object.freeze({
            source: Object.freeze({ directory: value.directory, kind: "files" as const })
        });
    }
    if (value.kind === "endpoint" && Object.keys(value).every((key) => key === "kind")) {
        return Object.freeze({
            source: Object.freeze({
                kind: "endpoint" as const,
                resolve: async () => {
                    const resolved = await bridge.invokeBinding(
                        applications.id,
                        context.id,
                        undefined,
                        { timeoutLabel: "Web application endpoint resolution" }
                    );
                    if (resolved === undefined) return undefined;
                    if (typeof resolved !== "string") {
                        throw new TypeError(
                            "Extension sandbox Web application endpoint returned a non-string URL."
                        );
                    }
                    return new URL(resolved);
                }
            })
        });
    }
    throw new TypeError(
        `Extension ${context.extensionId} web.applications/${context.id} sandbox descriptor is invalid.`
    );
}

export function validateWebApplicationBinding(
    value: unknown,
    context: ExtensionPointValidationContext
): asserts value is WebApplicationBinding {
    if (!isRecord(value) || !isRecord(value.source)) {
        throw new TypeError(
            `Extension ${context.extensionId} web.applications/${context.id} binding must provide source.`
        );
    }
    const source = value.source;
    if (source.kind === "files") {
        if (Object.keys(source).some((key) => key !== "directory" && key !== "kind")) {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} files source has unknown fields.`
            );
        }
        if (typeof source.directory !== "string" || source.directory.length === 0) {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} files directory must be non-empty.`
            );
        }
        return;
    }
    if (source.kind === "endpoint") {
        if (Object.keys(source).some((key) => key !== "kind" && key !== "resolve")) {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} endpoint source has unknown fields.`
            );
        }
        if (typeof source.resolve !== "function") {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} endpoint source must provide resolve().`
            );
        }
        return;
    }
    throw new TypeError(
        `Extension ${context.extensionId} web.applications/${context.id} source kind is invalid.`
    );
}

function readRecord(value: unknown, label: string): Record<string, ExtensionJsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, ExtensionJsonValue>;
    }
    throw new TypeError(`${label} must be an object.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
