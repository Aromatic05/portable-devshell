import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
    applications,
    type WebApplicationDeclaration,
    type WebApplicationBinding
} from "@portable-devshell/extension/web";
import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration
} from "@portable-devshell/extension";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext
} from "../../../control/extension/host/generation/ExtensionPointRegistry.js";
import {
    createWebApplicationSandboxBinding,
    validateWebApplicationBinding
} from "./WebApplicationExtensionSandboxCodec.js";

export const webApplicationsExtensionPointDefinition: ExtensionPointDefinition = Object.freeze({
    createSandboxBinding: createWebApplicationSandboxBinding,
    id: applications.id,
    parseDeclaration: parseWebApplicationDeclaration,
    validateBinding(binding: unknown, context: ExtensionPointValidationContext) {
        validateWebApplicationBinding(binding, context);
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

function parseWebApplicationDeclaration(value: ExtensionPointDeclaration): WebApplicationDeclaration {
    const record = value as ExtensionPointDeclaration & Record<string, ExtensionJsonValue | undefined>;
    const unknown = Object.keys(record).find((key) => key !== "id" && key !== "title");
    if (unknown !== undefined) throw new TypeError(`web.applications declaration has unknown field ${unknown}.`);
    if (typeof record.title !== "string" || record.title.length === 0 || record.title.trim() !== record.title) {
        throw new TypeError("web.applications declaration title must be a non-empty trimmed string.");
    }
    return Object.freeze({ id: value.id, title: record.title });
}

function resolveContainedPath(root: string, child: string, label: string): string {
    if (isAbsolute(child)) throw new TypeError(`${label} must be relative to the Extension code directory.`);
    const resolved = resolve(root, child);
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
    throw new TypeError(`${label} escapes the Extension code directory.`);
}
