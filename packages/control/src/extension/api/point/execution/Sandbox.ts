import type { ExecutionDriverDescriptor } from "@portable-devshell/extension/execution";
import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { ExtensionPointSandboxBridge, ExtensionPointSandboxInvocationContext, ExtensionPointValidationContext } from "../../../registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "../../../sandbox/bridge/PointCodec.js";

export function validateExecutionBinding(binding: unknown, context: ExtensionPointValidationContext, pointId: string): asserts binding is ExecutionDriverDescriptor {
    if (!isRecord(binding) || Object.keys(binding).some((key) => !["name", "version", "executable", "args", "options"].includes(key)) || binding.name !== context.id || binding.version !== 1) {
        throw new TypeError(`Extension ${context.extensionId} ${pointId}/${context.id} must provide a version 1 Worker driver descriptor whose name matches its registration id.`);
    }
    if (binding.executable !== undefined && (typeof binding.executable !== "string" || binding.executable.length === 0 || binding.executable.trim() !== binding.executable)) throw new TypeError(`${pointId}/${context.id} executable must be a non-empty trimmed string.`);
    if (binding.args !== undefined && (!Array.isArray(binding.args) || binding.args.some((arg) => typeof arg !== "string"))) throw new TypeError(`${pointId}/${context.id} args must be an array of strings.`);
    if (binding.options !== undefined && !isJsonValue(binding.options)) throw new TypeError(`${pointId}/${context.id} options must be JSON serializable.`);
}

export const executionEnvironmentSandboxCodec = createCodec("execution.environment");
export const executionSandboxSandboxCodec = createCodec("execution.sandbox");
function createCodec(id: string): ExtensionSandboxPointCodec {
    return Object.freeze({
        id,
        describeBinding(binding: unknown, context: ExtensionPointValidationContext): ExtensionJsonValue {
            validateExecutionBinding(binding, context, id);
            return structuredClone(binding) as ExtensionJsonValue;
        },
        invokeBinding(binding: unknown, input: ExtensionJsonValue | undefined, _signal: AbortSignal, context: ExtensionPointSandboxInvocationContext): unknown {
            validateExecutionBinding(binding, context, id);
            if (input !== undefined) throw new TypeError(`${id} driver descriptors do not accept invocation input.`);
            return structuredClone(binding);
        },
    });
}

export function createExecutionSandboxBinding(descriptor: ExtensionJsonValue, context: ExtensionPointValidationContext, _bridge: ExtensionPointSandboxBridge, pointId: string): ExecutionDriverDescriptor {
    validateExecutionBinding(descriptor, context, pointId);
    return Object.freeze(structuredClone(descriptor)) as ExecutionDriverDescriptor;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isJsonValue(value: unknown): value is ExtensionJsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    return isRecord(value) && Object.values(value).every(isJsonValue);
}
