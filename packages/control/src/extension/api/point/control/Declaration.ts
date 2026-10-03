import {
    routes,
    type ControlRouteDeclaration,
} from "@portable-devshell/extension/control";
import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration,
} from "@portable-devshell/extension";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext,
} from "../../../registration/PointRegistry.js";
import { createControlRouteSandboxBinding, validateControlRouteBinding } from "./Sandbox.js";

export const controlRoutesExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createControlRouteSandboxBinding,
        id: routes.id,
        parseDeclaration: parseControlRouteDeclaration,
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateControlRouteBinding(binding, context);
        },
    });

export function parseControlRouteDeclaration(
    value: ExtensionPointDeclaration,
): ControlRouteDeclaration {
    const record = value as ExtensionPointDeclaration &
        Record<string, ExtensionJsonValue | undefined>;
    const unknown = Object.keys(record).find(
        (key) =>
            key !== "id" &&
            key !== "module" &&
            key !== "operation" &&
            key !== "scope",
    );
    if (unknown !== undefined) {
        throw new TypeError(
            `control.routes declaration has unknown field ${unknown}.`,
        );
    }
    const scope =
        record.scope === "control" || record.scope === "instance"
            ? record.scope
            : undefined;
    if (scope === undefined) {
        throw new TypeError(
            "control.routes declaration scope must be control or instance.",
        );
    }
    return Object.freeze({
        id: value.id,
        module: readRouteSegment(record.module, "module"),
        operation: readRouteSegment(record.operation, "operation"),
        scope,
    });
}

function readRouteSegment(
    value: ExtensionJsonValue | undefined,
    label: string,
): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    if (value.trim() !== value || value.includes(".")) {
        throw new TypeError(
            `control.routes declaration ${label} must be a trimmed route segment without dots.`,
        );
    }
    return value;
}
