import { environment, sandbox, type ExecutionDriverDescriptor } from "@portable-devshell/extension/execution";
import type { ExtensionJsonValue, ExtensionPointDeclaration } from "@portable-devshell/extension";
import type { ExtensionPointDefinition, ExtensionPointSandboxBridge, ExtensionPointValidationContext } from "../../../registration/PointRegistry.js";
import { createExecutionSandboxBinding, validateExecutionBinding } from "./Sandbox.js";

export const executionEnvironmentExtensionPointDefinition = createDefinition(environment.id);
export const executionSandboxExtensionPointDefinition = createDefinition(sandbox.id);

function createDefinition(pointId: string): ExtensionPointDefinition {
    return Object.freeze({
        createSandboxBinding: (descriptor: ExtensionJsonValue, context: ExtensionPointValidationContext, bridge: ExtensionPointSandboxBridge) => createExecutionSandboxBinding(descriptor, context, bridge, pointId),
        id: pointId,
        parseDeclaration(value: ExtensionPointDeclaration) {
            const unknown = Object.keys(value).find((key) => key !== "id");
            if (unknown !== undefined) throw new TypeError(`${pointId} declaration has unknown field ${unknown}.`);
            if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value.id))
                throw new TypeError(`${pointId} declaration id must be a lowercase provider name.`);
            return Object.freeze({ id: value.id });
        },
        validateBinding(binding: unknown, context: ExtensionPointValidationContext) {
            validateExecutionBinding(binding, context, pointId);
        },
    });
}

export function readExecutionDriver(value: ExtensionJsonValue, context: ExtensionPointValidationContext, pointId: string): ExecutionDriverDescriptor {
    validateExecutionBinding(value, context, pointId);
    return value as ExecutionDriverDescriptor;
}
