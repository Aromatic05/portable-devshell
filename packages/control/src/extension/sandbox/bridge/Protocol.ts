import {
    ExtensionError,
    type ExtensionCapability,
    type ExtensionConfigChange,
    type ExtensionJsonValue,
    type ExtensionPaths,
} from "@portable-devshell/extension";
import type { ExtensionAssetProjectionInput } from "@portable-devshell/extension/asset";
import type {
    ExtensionProcessExit,
    ExtensionProcessStartInput,
} from "@portable-devshell/extension/process";
import type {
    ExtensionWorkerEnvironment,
    ExtensionWorkerOpenInput,
    ExtensionWorkerToolDefinition,
} from "@portable-devshell/extension/worker";
import type {
    ExtensionArtifactShareInput,
    ExtensionArtifactTransferInput,
} from "@portable-devshell/extension/artifact";
import type { ExtensionContextQuery } from "@portable-devshell/extension/context";
import type { ExtensionInstanceLogQuery } from "@portable-devshell/extension/instance";
import type { ToolCallHistoryQuery } from "@portable-devshell/extension/toolcall";
import {
    createRemoteError,
    toRemoteErrorBody,
    type RemoteErrorBody,
} from "@portable-devshell/shared";
export {
    EXTENSION_SANDBOX_MAX_MESSAGE_BYTES,
    assertExtensionSandboxMessage,
} from "./MessageGuard.js";
export interface ExtensionSandboxContextData {
    config?: boolean;
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
    hostDependencies: Readonly<Record<string, string>>;
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
    | { kind: "deactivate" }
    | {
          ctxId: string;
          instance: string;
          kind: "contextEnvironmentRetired";
          reason: "disabled" | "expired";
      }
    | { instance: string; kind: "instanceGenerationRetired" };

export type ExtensionSandboxCapabilityOperation =
    | "artifacts.cancelTransfer"
    | "artifacts.createShare"
    | "artifacts.getTransfer"
    | "artifacts.listShares"
    | "artifacts.listTransfers"
    | "artifacts.revokeShare"
    | "artifacts.startTransfer"
    | "artifacts.waitForTransfer"
    | "assets.installBundle"
    | "assets.installDirectory"
    | "assets.listBundles"
    | "assets.projectBundle"
    | "assets.removeBundle"
    | "assets.resolveBundle"
    | "config.get"
    | "config.update"
    | "configCore.get"
    | "configCore.update"
    | "contextObserve.list"
    | "instanceEventPublish.appendEvent"
    | "instanceManage.create"
    | "instanceManage.createSchema"
    | "instanceManage.delete"
    | "instanceManage.disable"
    | "instanceManage.enable"
    | "instanceManage.start"
    | "instanceManage.stop"
    | "instanceManage.validateCreate"
    | "instanceObserve.list"
    | "instanceObserve.readLogs"
    | "instanceObserve.refresh"
    | "instanceObserve.snapshot"
    | "instanceObserve.watchEvents"
    | "toolCallHistory.listInstances"
    | "toolCallHistory.read"
    | "processes.send"
    | "processes.start"
    | "processes.terminate"
    | "workerDelegate.callTool"
    | "workerDelegate.closeSession"
    | "workerDelegate.openSession"
    | "workerExecute.callTool"
    | "workerExecute.closeSession"
    | "workerExecute.openSession";

export type ExtensionSandboxInterfaceOperation =
    | "secret.environment"
    | "cli.context.instanceReference"
    | "cli.readInput"
    | "cli.requestInput"
    | "cli.writeStderr"
    | "cli.writeStdout";

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
    body: RemoteErrorBody;
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
          input?: ExtensionJsonValue;
          invocationId: string;
          operation: ExtensionSandboxInterfaceOperation;
          type: "interfaceRequest";
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
          error: ExtensionSandboxError;
          id: string;
          type: "interfaceError";
      }
    | {
          id: string;
          type: "interfaceResult";
          value?: ExtensionJsonValue;
      }
    | {
          id: string;
          type: "healthPing";
      }
    | {
          change: ExtensionConfigChange;
          type: "configChange";
      }
    | {
          change: ExtensionConfigChange;
          type: "configCoreChange";
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
          type: "processStdout";
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

export type SandboxAssetProjectInput = Omit<
    ExtensionAssetProjectionInput,
    "signal"
>;
export type SandboxArtifactShareInput = ExtensionArtifactShareInput;
export type SandboxArtifactTransferInput = ExtensionArtifactTransferInput;
export interface SandboxConfigGetInput {
    path: string;
}
export type SandboxConfigUpdateInput = Readonly<
    Record<string, ExtensionJsonValue>
>;
export type SandboxContextObserveListInput = ExtensionContextQuery;
export interface SandboxInstanceNameInput {
    name: string;
}
export interface SandboxInstanceCreateInput {
    draft: ExtensionJsonValue;
}
export interface SandboxInstanceReadLogsInput {
    name: string;
    query?: ExtensionInstanceLogQuery;
}
export interface SandboxInstanceWatchInput {
    seed?: boolean;
    eventTypes?: readonly string[];
    fromSeq: number;
    name: string;
}
export interface SandboxInstanceEventPublishInput {
    data?: ExtensionJsonValue;
    name: string;
    type: string;
}
export interface SandboxToolCallHistoryReadInput {
    instance: string;
    query?: ToolCallHistoryQuery;
}
export type SandboxWorkerOpenInput = ExtensionWorkerOpenInput;

export function serializeSandboxError(error: unknown): ExtensionSandboxError {
    const sourceBody =
        error instanceof ExtensionError
            ? {
                  code: error.code,
                  ...(error.details === undefined
                      ? {}
                      : { details: error.details }),
                  message: error.message,
                  retryable: error.retryable,
              }
            : (toRemoteErrorBody(error) ?? {
                  code: "error.unknown",
                  message:
                      error instanceof Error ? error.message : String(error),
                  retryable: false,
              });
    const body: RemoteErrorBody = {
        code: sourceBody.code,
        ...(sourceBody.details === undefined
            ? {}
            : { details: sourceBody.details }),
        message: sourceBody.message,
        retryable: sourceBody.retryable,
    };
    const name = error instanceof Error ? error.name : "Error";
    const errors =
        error instanceof AggregateError
            ? error.errors.map((candidate) => serializeSandboxError(candidate))
            : undefined;
    return {
        body,
        ...(errors === undefined ? {} : { errors }),
        name,
    };
}

export function deserializeSandboxError(
    serialized: ExtensionSandboxError,
): Error {
    let error: Error;
    if (serialized.name === "AggregateError") {
        error = new AggregateError(
            (serialized.errors ?? []).map((candidate) =>
                deserializeSandboxError(candidate),
            ),
            serialized.body.message,
        );
    } else if (serialized.body.code !== "error.unknown") {
        error = createRemoteError({
            code: serialized.body.code,
            ...(serialized.body.details === undefined
                ? {}
                : { details: serialized.body.details }),
            message: serialized.body.message,
            retryable: serialized.body.retryable,
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
