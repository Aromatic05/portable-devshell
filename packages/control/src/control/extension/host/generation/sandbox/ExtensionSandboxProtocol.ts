import type {
    ExtensionAssetProjectionInput,
    ExtensionCommandResult,
    ExtensionInstanceRetireEvent,
    ExtensionInvocationContext,
    ExtensionJsonValue,
    ExtensionPaths,
    ExtensionToolDefinition,
    ExtensionWorkerEnvironment,
    ExtensionWorkerOpenInput
} from "@portable-devshell/extension";
import {
    createError,
    toControlErrorBody,
    type ControlErrorBody
} from "@portable-devshell/shared";

export interface ExtensionSandboxContextData {
    generation: string;
    id: string;
    paths: ExtensionPaths;
    version: string;
}

export interface ExtensionSandboxWorkerData {
    codeDirectory: string;
    context: ExtensionSandboxContextData;
    entryUrl: string;
}

export interface ExtensionSandboxActivationDescriptor {
    command?: true;
    lifecycle?: { onInstanceRetire: true };
    rpc?: readonly string[];
    web?:
        | { directory: string; kind: "static" }
        | { kind: "proxy" };
}

export interface ExtensionSandboxInvocationContextData {
    localOwner: boolean;
    requestId: string;
    workingDirectory?: string;
}

export type ExtensionSandboxInvokeOperation =
    | {
          argv: readonly string[];
          context: ExtensionSandboxInvocationContextData;
          kind: "command";
      }
    | {
          context: ExtensionSandboxInvocationContextData;
          input?: ExtensionJsonValue;
          kind: "rpc";
          operation: string;
      }
    | {
          event: ExtensionInstanceRetireEvent;
          kind: "instanceRetire";
      }
    | { kind: "resolveUpstream" }
    | { kind: "dispose" };

export type ExtensionSandboxCapabilityOperation =
    | "assets.installBundle"
    | "assets.installDirectory"
    | "assets.listBundles"
    | "assets.projectBundle"
    | "assets.removeBundle"
    | "assets.resolveBundle"
    | "worker.callTool"
    | "worker.closeSession"
    | "worker.openSession";

export interface ExtensionSandboxWorkerSessionDescriptor {
    environment: ExtensionWorkerEnvironment;
    instance: string;
    sessionId: string;
    tools: readonly ExtensionToolDefinition[];
    workspace: string;
}

export interface ExtensionSandboxError {
    body: ControlErrorBody;
    errors?: readonly ExtensionSandboxError[];
    name: string;
    stack?: string;
}

export type ExtensionSandboxToHostMessage =
    | {
          activation: ExtensionSandboxActivationDescriptor;
          type: "ready";
      }
    | {
          error: ExtensionSandboxError;
          type: "initError";
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

export type SandboxAssetProjectInput = Omit<ExtensionAssetProjectionInput, "signal">;
export type SandboxWorkerOpenInput = ExtensionWorkerOpenInput;
export type SandboxCommandResult = ExtensionCommandResult;

export function invocationContextData(
    context: ExtensionInvocationContext
): ExtensionSandboxInvocationContextData {
    return {
        localOwner: context.localOwner,
        requestId: context.requestId,
        ...(context.workingDirectory === undefined ? {} : {
            workingDirectory: context.workingDirectory
        })
    };
}

export function serializeSandboxError(error: unknown): ExtensionSandboxError {
    const body = toControlErrorBody(error) ?? {
        code: "error.unknown",
        message: error instanceof Error ? error.message : String(error),
        retryable: false
    };
    const name = error instanceof Error ? error.name : "Error";
    const errors = error instanceof AggregateError
        ? error.errors.map((candidate) => serializeSandboxError(candidate))
        : undefined;
    return {
        body,
        ...(errors === undefined ? {} : { errors }),
        name,
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
    };
}

export function deserializeSandboxError(serialized: ExtensionSandboxError): Error {
    const cause = serialized.body.cause === undefined
        ? undefined
        : controlBodyToError(serialized.body.cause);
    let error: Error;
    if (serialized.name === "AggregateError") {
        error = new AggregateError(
            (serialized.errors ?? []).map((candidate) => deserializeSandboxError(candidate)),
            serialized.body.message,
            cause === undefined ? undefined : { cause }
        );
    } else if (serialized.body.code !== "error.unknown") {
        error = createError({
            code: serialized.body.code,
            ...(cause === undefined ? {} : { cause }),
            ...(serialized.body.details === undefined ? {} : { details: serialized.body.details }),
            message: serialized.body.message,
            retryable: serialized.body.retryable
        });
    } else if (serialized.name === "TypeError") {
        error = new TypeError(
            serialized.body.message,
            cause === undefined ? undefined : { cause }
        );
    } else if (serialized.name === "RangeError") {
        error = new RangeError(
            serialized.body.message,
            cause === undefined ? undefined : { cause }
        );
    } else {
        error = new Error(
            serialized.body.message,
            cause === undefined ? undefined : { cause }
        );
        error.name = serialized.name;
    }
    if (serialized.stack !== undefined) error.stack = serialized.stack;
    return error;
}

function controlBodyToError(body: ControlErrorBody): Error {
    return createError({
        code: body.code,
        ...(body.cause === undefined ? {} : { cause: controlBodyToError(body.cause) }),
        ...(body.details === undefined ? {} : { details: body.details }),
        message: body.message,
        retryable: body.retryable
    });
}
