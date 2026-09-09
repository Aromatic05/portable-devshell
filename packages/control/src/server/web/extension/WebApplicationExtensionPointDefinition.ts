import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
    applications,
    parseWebApplicationDeclaration,
    type WebApplicationBinding
} from "@portable-devshell/extension/web";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext
} from "../../../control/extension/host/generation/ExtensionPointRegistry.js";

export const webApplicationsExtensionPointDefinition: ExtensionPointDefinition = Object.freeze({
    id: applications.id,
    parseDeclaration: parseWebApplicationDeclaration,
    validateBinding(binding: unknown, context: ExtensionPointValidationContext) {
        validateWebBinding(binding, context);
    },
    async validateBindingResources(binding: unknown, context: ExtensionPointValidationContext) {
        const source = (binding as WebApplicationBinding).source;
        if (source.kind !== "files") return;
        const directory = resolveContainedPath(
            context.codeDirectory,
            source.directory,
            "Web application directory"
        );
        const info = await lstat(directory).catch(() => undefined);
        if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
            throw new TypeError(
                `Extension ${context.extensionId} web.applications/${context.id} files source is not a plain directory.`
            );
        }
    }
});

function validateWebBinding(
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

function resolveContainedPath(root: string, child: string, label: string): string {
    if (isAbsolute(child)) throw new TypeError(`${label} must be relative to the Extension code directory.`);
    const resolved = resolve(root, child);
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
    throw new TypeError(`${label} escapes the Extension code directory.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
