import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
    applications,
    pages,
    type WebApplicationDeclaration,
    type WebApplicationBinding,
} from "@portable-devshell/extension/web";
import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration,
} from "@portable-devshell/extension";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext,
} from "../../../control/extension/generation/registration/PointRegistry.js";
import {
    createWebApplicationSandboxBinding,
    createWebPageSandboxBinding,
    validateWebApplicationBinding,
    validateWebPageBinding,
} from "./Sandbox.js";

export const webApplicationsExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createWebApplicationSandboxBinding,
        id: applications.id,
        parseDeclaration: parseWebApplicationDeclaration,
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateWebApplicationBinding(binding, context);
        },
        async validateBindingResources(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            const source = (binding as WebApplicationBinding).source;
            if (source.kind !== "files") return;
            const directory = resolveContainedPath(
                context.codeDirectory,
                source.directory,
                "Web application directory",
            );
            const info = await lstat(directory).catch(() => undefined);
            if (
                info === undefined ||
                !info.isDirectory() ||
                info.isSymbolicLink()
            ) {
                throw new TypeError(
                    `Extension ${context.extensionId} web.applications/${context.id} files source is not a plain directory.`,
                );
            }
        },
    });

export const webPagesExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createWebPageSandboxBinding,
        id: pages.id,
        parseDeclaration: (declaration: ExtensionPointDeclaration) =>
            parseWebDeclaration(declaration, pages.id),
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateWebPageBinding(binding, context);
        },
    });

function parseWebApplicationDeclaration(
    value: ExtensionPointDeclaration,
): WebApplicationDeclaration {
    return parseWebDeclaration(value, applications.id);
}

function parseWebDeclaration(
    value: ExtensionPointDeclaration,
    pointId: string,
): WebApplicationDeclaration {
    const record = value as ExtensionPointDeclaration &
        Record<string, ExtensionJsonValue | undefined>;
    const unknown = Object.keys(record).find(
        (key) => key !== "id" && key !== "title",
    );
    if (unknown !== undefined)
        throw new TypeError(
            `${pointId} declaration has unknown field ${unknown}.`,
        );
    if (
        typeof record.title !== "string" ||
        record.title.length === 0 ||
        record.title.trim() !== record.title
    ) {
        throw new TypeError(
            `${pointId} declaration title must be a non-empty trimmed string.`,
        );
    }
    return Object.freeze({ id: value.id, title: record.title });
}

function resolveContainedPath(
    root: string,
    child: string,
    label: string,
): string {
    if (isAbsolute(child))
        throw new TypeError(
            `${label} must be relative to the Extension code directory.`,
        );
    const resolved = resolve(root, child);
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
        return resolved;
    throw new TypeError(`${label} escapes the Extension code directory.`);
}
