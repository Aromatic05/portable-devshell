import { defineExtensionPoint, type ExtensionPointDeclaration } from "../ExtensionCore.js";

export interface ExecutionDriverDescriptor extends Record<string, import("../ExtensionCore.js").ExtensionJsonValue> {
    readonly name: string;
    readonly version: number;
}

export interface ExecutionProviderDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
}

/** Static Worker driver descriptions are transported as JSON; Control never executes their scripts. */
export const environment = defineExtensionPoint<ExecutionProviderDeclaration, ExecutionDriverDescriptor>("execution.environment");
/** Exactly one sandbox provider may be selected for an execution. */
export const sandbox = defineExtensionPoint<ExecutionProviderDeclaration, ExecutionDriverDescriptor>("execution.sandbox");
