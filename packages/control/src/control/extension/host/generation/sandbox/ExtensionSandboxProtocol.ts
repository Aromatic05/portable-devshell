import type {
    ExtensionAssetProjectionInput,
    ExtensionCapability,
    ExtensionJsonValue,
    ExtensionPaths,
    ExtensionProcessExit,
    ExtensionProcessStartInput,
    ExtensionWorkerEnvironment,
    ExtensionWorkerToolDefinition,
    ExtensionWorkerOpenInput
} from "@portable-devshell/extension";
import {
    createError,
    toControlErrorBody,
    type ControlErrorBody
} from "@portable-devshell/shared";
import { TRANSPORT_MAX_FRAME_SIZE } from "@portable-devshell/shared/transport/frame";

export const EXTENSION_SANDBOX_MAX_MESSAGE_BYTES = TRANSPORT_MAX_FRAME_SIZE;
const EXTENSION_SANDBOX_MAX_MESSAGE_DEPTH = 128;
const EXTENSION_SANDBOX_MAX_MESSAGE_NODES = 100_000;

const SandboxWeakSet = WeakSet;
const sandboxApply = Reflect.apply.bind(Reflect);
const sandboxArrayIsArray = Array.isArray;
const sandboxByteLength = Buffer.byteLength;
const sandboxGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const sandboxGetPrototypeOf = Object.getPrototypeOf;
const sandboxJsonStringify = JSON.stringify;
const sandboxNumberIsFinite = Number.isFinite;
const sandboxNumberIsSafeInteger = Number.isSafeInteger;
const sandboxOwnKeys = Reflect.ownKeys;
const sandboxPlainObjectPrototype = Object.prototype;
const sandboxToNumber = Number;
const sandboxWeakSetAdd = WeakSet.prototype.add;
const sandboxWeakSetDelete = WeakSet.prototype.delete;
const sandboxWeakSetHas = WeakSet.prototype.has;

export interface ExtensionSandboxContextData {
    generation: string;
    id: string;
    paths: ExtensionPaths;
    version: string;
}

export interface ExtensionSandboxWorkerData {
    capabilities: readonly ExtensionCapability[];
    codeDirectory: string;
    context: ExtensionSandboxContextData;
    entryUrl: string;
    hostDependencies: readonly string[];
}

export interface ExtensionSandboxRegistrationDescriptor {
    descriptor: ExtensionJsonValue;
    id: string;
    pointId: string;
}

export interface ExtensionSandboxReadyDescriptor {
    registrations: readonly ExtensionSandboxRegistrationDescriptor[];
}

export type ExtensionSandboxInvokeOperation =
    | {
          id: string;
          input?: ExtensionJsonValue;
          kind: "binding";
          pointId: string;
      }
    | { kind: "deactivate" };

export type ExtensionSandboxCapabilityOperation =
    | "assets.installBundle"
    | "assets.installDirectory"
    | "assets.listBundles"
    | "assets.projectBundle"
    | "assets.removeBundle"
    | "assets.resolveBundle"
    | "processes.send"
    | "processes.start"
    | "processes.terminate"
    | "workers.callTool"
    | "workers.closeSession"
    | "workers.openSession";

export interface ExtensionSandboxWorkerSessionDescriptor {
    environment: ExtensionWorkerEnvironment;
    instance: string;
    sessionId: string;
    tools: readonly ExtensionWorkerToolDefinition[];
    workspace: string;
}

export interface ExtensionSandboxProcessDescriptor {
    processId: string;
}

export interface ExtensionSandboxError {
    body: ControlErrorBody;
    errors?: readonly ExtensionSandboxError[];
    name: string;
}

export type ExtensionSandboxToHostMessage =
    | {
          descriptor: ExtensionSandboxReadyDescriptor;
          type: "ready";
      }
    | {
          error: ExtensionSandboxError;
          type: "initError";
      }
    | {
          error: ExtensionSandboxError;
          type: "runtimeFault";
      }
    | {
          error: ExtensionSandboxError;
          id: string;
          type: "invokeError";
      }
    | {
          id: string;
          type: "invokeResult";
          value?: unknown;
      }
    | {
          id: string;
          input?: unknown;
          operation: ExtensionSandboxCapabilityOperation;
          type: "capabilityRequest";
      }
    | {
          error: ExtensionSandboxError;
          id: string;
          type: "capabilityCancel";
      }
    | {
          id: string;
          type: "healthPong";
      }
    | {
          details?: ExtensionJsonValue;
          level: "debug" | "error" | "info" | "warn";
          message: string;
          type: "log";
      };

export type ExtensionHostToSandboxMessage =
    | {
          id: string;
          operation: ExtensionSandboxInvokeOperation;
          type: "invoke";
      }
    | {
          error: ExtensionSandboxError;
          id: string;
          type: "invokeCancel";
      }
    | {
          error: ExtensionSandboxError;
          id: string;
          type: "capabilityError";
      }
    | {
          id: string;
          type: "capabilityProgress";
          value: ExtensionJsonValue;
      }
    | {
          id: string;
          type: "capabilityResult";
          value?: unknown;
      }
    | {
          id: string;
          type: "healthPing";
      }
    | {
          sessionId: string;
          type: "workerSessionClosed";
      }
    | {
          message: ExtensionJsonValue;
          processId: string;
          type: "processMessage";
      }
    | {
          chunk: string;
          processId: string;
          type: "processStderr";
      }
    | {
          exit: ExtensionProcessExit;
          processId: string;
          type: "processClosed";
      };

export interface SandboxWorkerCallInput {
    input: ExtensionJsonValue;
    operationId?: string;
    sessionId: string;
    toolName: string;
}

export interface SandboxWorkerCloseInput {
    sessionId: string;
}

export type SandboxProcessStartInput = ExtensionProcessStartInput;

export interface SandboxProcessSendInput {
    message: ExtensionJsonValue;
    processId: string;
}

export interface SandboxProcessTerminateInput {
    processId: string;
    signal?: string;
}

export type SandboxAssetProjectInput = Omit<ExtensionAssetProjectionInput, "signal">;
export type SandboxWorkerOpenInput = ExtensionWorkerOpenInput;

/**
 * MessagePort does not impose the framed transport budget used elsewhere in
 * portable-devshell. Validate the complete private sandbox envelope before
 * structured clone can allocate a second copy in the receiving isolate.
 */
export function assertExtensionSandboxMessage(
    value: unknown,
    label: string,
    maxBytes = EXTENSION_SANDBOX_MAX_MESSAGE_BYTES
): void {
    if (!sandboxNumberIsSafeInteger(maxBytes) || maxBytes < 1) {
        throw new TypeError("Extension sandbox message byte limit must be a positive safe integer.");
    }
    const stack: SandboxValidationFrame[] = [{ depth: 0, entering: true, value }];
    let stackLength = 1;
    const ancestors = new SandboxWeakSet<object>();
    let bytes = 0;
    let nodes = 0;

    while (stackLength > 0) {
        const frame = stack[--stackLength]!;
        const candidate = frame.value;
        if (!frame.entering) {
            sandboxApply(sandboxWeakSetDelete, ancestors, [candidate as object]);
            continue;
        }
        nodes += 1;
        if (nodes > EXTENSION_SANDBOX_MAX_MESSAGE_NODES) {
            throw new TypeError(`${label} exceeds the sandbox message node limit.`);
        }
        if (frame.depth > EXTENSION_SANDBOX_MAX_MESSAGE_DEPTH) {
            throw new TypeError(`${label} exceeds the sandbox message depth limit.`);
        }

        if (candidate === null) {
            bytes = addSandboxMessageBytes(bytes, 4, maxBytes, label);
            continue;
        }
        switch (typeof candidate) {
            case "string":
                bytes = addSandboxMessageBytes(
                    bytes,
                    jsonStringBytes(candidate, maxBytes - bytes),
                    maxBytes,
                    label
                );
                continue;
            case "boolean":
                bytes = addSandboxMessageBytes(bytes, candidate ? 4 : 5, maxBytes, label);
                continue;
            case "number": {
                if (!sandboxNumberIsFinite(candidate)) {
                    throw new TypeError(`${label} contains a non-finite number.`);
                }
                const encoded = sandboxJsonStringify(candidate);
                if (encoded === undefined) throw new TypeError(`${label} contains an invalid number.`);
                bytes = addSandboxMessageBytes(bytes, encoded.length, maxBytes, label);
                continue;
            }
            case "object":
                break;
            default:
                throw new TypeError(`${label} contains a non-JSON value.`);
        }

        const object = candidate as object;
        if (sandboxApply(sandboxWeakSetHas, ancestors, [object]) as boolean) {
            throw new TypeError(`${label} contains a cyclic object graph.`);
        }
        sandboxApply(sandboxWeakSetAdd, ancestors, [object]);
        stack[stackLength++] = { depth: frame.depth, entering: false, value: candidate };

        if (sandboxArrayIsArray(candidate)) {
            const structuralBytes = candidate.length === 0 ? 2 : candidate.length + 1;
            bytes = addSandboxMessageBytes(bytes, structuralBytes, maxBytes, label);
            assertJsonArrayShape(candidate, label);
            for (let index = candidate.length - 1; index >= 0; index -= 1) {
                stack[stackLength++] = {
                    depth: frame.depth + 1,
                    entering: true,
                    value: candidate[index]
                };
            }
            continue;
        }

        const prototype = sandboxGetPrototypeOf(candidate);
        if (prototype !== sandboxPlainObjectPrototype && prototype !== null) {
            throw new TypeError(`${label} contains a non-plain object.`);
        }
        const keys = sandboxOwnKeys(candidate);
        const propertyCount = keys.length;
        bytes = addSandboxMessageBytes(
            bytes,
            propertyCount === 0 ? 2 : propertyCount + 1,
            maxBytes,
            label
        );
        for (let index = propertyCount - 1; index >= 0; index -= 1) {
            const key = keys[index]!;
            if (typeof key !== "string") {
                throw new TypeError(`${label} contains a symbol property.`);
            }
            const descriptor = sandboxGetOwnPropertyDescriptor(candidate, key);
            if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
                throw new TypeError(`${label} contains a non-enumerable or accessor property.`);
            }
            if (descriptor.value === undefined) {
                throw new TypeError(`${label} contains undefined.`);
            }
            bytes = addSandboxMessageBytes(
                bytes,
                jsonStringBytes(key, maxBytes - bytes) + 1,
                maxBytes,
                label
            );
            stack[stackLength++] = {
                depth: frame.depth + 1,
                entering: true,
                value: descriptor.value
            };
        }
    }
}

export function serializeSandboxError(error: unknown): ExtensionSandboxError {
    const sourceBody = toControlErrorBody(error) ?? {
        code: "error.unknown",
        message: error instanceof Error ? error.message : String(error),
        retryable: false
    };
    const body: ControlErrorBody = {
        code: sourceBody.code,
        ...(sourceBody.details === undefined ? {} : { details: sourceBody.details }),
        message: sourceBody.message,
        retryable: sourceBody.retryable
    };
    const name = error instanceof Error ? error.name : "Error";
    const errors = error instanceof AggregateError
        ? error.errors.map((candidate) => serializeSandboxError(candidate))
        : undefined;
    return {
        body,
        ...(errors === undefined ? {} : { errors }),
        name
    };
}

export function deserializeSandboxError(serialized: ExtensionSandboxError): Error {
    let error: Error;
    if (serialized.name === "AggregateError") {
        error = new AggregateError(
            (serialized.errors ?? []).map((candidate) => deserializeSandboxError(candidate)),
            serialized.body.message
        );
    } else if (serialized.body.code !== "error.unknown") {
        error = createError({
            code: serialized.body.code,
            ...(serialized.body.details === undefined ? {} : { details: serialized.body.details }),
            message: serialized.body.message,
            retryable: serialized.body.retryable
        });
    } else if (serialized.name === "TypeError") {
        error = new TypeError(serialized.body.message);
    } else if (serialized.name === "RangeError") {
        error = new RangeError(serialized.body.message);
    } else {
        error = new Error(serialized.body.message);
        error.name = serialized.name;
    }
    return error;
}

interface SandboxValidationFrame {
    depth: number;
    entering: boolean;
    value: unknown;
}

function assertJsonArrayShape(value: unknown[], label: string): void {
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = sandboxGetOwnPropertyDescriptor(value, `${index}`);
        if (
            descriptor === undefined
            || descriptor.enumerable !== true
            || !("value" in descriptor)
            || descriptor.value === undefined
        ) {
            throw new TypeError(`${label} contains an array hole, accessor, or undefined value.`);
        }
    }
    const keys = sandboxOwnKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        if (key === "length") continue;
        if (typeof key !== "string" || !isCanonicalArrayIndex(key, value.length)) {
            throw new TypeError(`${label} contains a non-JSON array property.`);
        }
    }
}

function isCanonicalArrayIndex(value: string, length: number): boolean {
    if (value.length === 0) return false;
    const index = sandboxToNumber(value);
    return sandboxNumberIsSafeInteger(index)
        && index >= 0
        && index < length
        && `${index}` === value;
}

function jsonStringBytes(value: string, remainingBytes: number): number {
    const rawBytes = sandboxByteLength(value, "utf8") + 2;
    if (rawBytes > remainingBytes) return rawBytes;
    const encoded = sandboxJsonStringify(value);
    if (encoded === undefined) throw new TypeError("Extension sandbox string could not be JSON encoded.");
    return sandboxByteLength(encoded, "utf8");
}

function addSandboxMessageBytes(
    current: number,
    addition: number,
    maxBytes: number,
    label: string
): number {
    const next = current + addition;
    if (next > maxBytes) {
        throw new TypeError(`${label} exceeds the ${maxBytes}-byte sandbox message limit.`);
    }
    return next;
}
