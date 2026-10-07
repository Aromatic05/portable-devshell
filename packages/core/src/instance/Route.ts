import {
    routeModule,
    asInstanceName,
    createRemoteError,
    controlErrorCodes,
    createToolRouteModule,
    ENVIRONMENT_PORT,
    INSTANCE_RUNTIME_PORT,
    isProcessEventType,
    runtimeErrorCodes,
    type ProcessEvent,
    type JsonValue,
    type ControlStreamMessage,
    mergeControlPortsByName,
    type ControlHostDefinition,
    type ControlPortDefinition,
} from "@portable-devshell/shared";

import { createApprovalRouteModule } from "../approval/Route.js";
import { createGoalTaskRouteModule } from "../task/goal/Route.js";
import { createTodoTaskRouteModule } from "../task/todo/Route.js";
import { createTerminalRouteModule } from "../terminal/Route.js";
import { ProcessInteractiveSession } from "./runtime/execution/Interactive.js";
import type { ProcessSubscriptionManager } from "@portable-devshell/shared";
import type { Instance } from "./model/Instance.js";
import type { InstanceState } from "./model/State.js";

export interface InstanceRouteOptions {
    descriptor: Instance;
    extensionPorts?: readonly ControlPortDefinition[];
    state: InstanceState;
}

export function createInstanceHost(
    options: InstanceRouteOptions,
): ControlHostDefinition {
    const { descriptor, state } = options;
    const events = {
        cursor: () => descriptor.worker.supervision.snapshot().lastSeq,
        subscribe: (fromSeq?: number) =>
            descriptor.worker.supervision.state.subscribe(fromSeq),
    };
    const name = descriptor.config.name;
    const ports = mergeControlPortsByName([
        createInstanceRuntimeRouteModule(descriptor),
        createEnvironmentRouteModule(descriptor),
        createProcessRouteModule(descriptor, state, state.subscriptions),
        createApprovalRouteModule(
            { approval: state.approval.api, events, name },
            state.subscriptions,
        ),
        createTerminalRouteModule({
            backend: state.terminal.api,
            instance: name,
            sessions: state.terminal.sessions.api,
        }),
        createGoalTaskRouteModule({ events, goal: state.task.api.goal }),
        createTodoTaskRouteModule(
            { events, name, todo: state.task.api.todo },
            state.subscriptions,
        ),
        createToolRouteModule(
            {
                name,
                worker: {
                    readWorkerTools: async () => state.toolDefinitions.list(),
                    prepareWorkspace: (workspace, connectionId) =>
                        state.openToolSession(workspace, connectionId),
                    readToolCalls: (query) => state.tools.readToolCalls(query),
                    readToolCallFailureSummary: (sinceMs, untilMs) =>
                        state.tools.readToolCallFailureSummary(sinceMs, untilMs),
                    dispatchToolCall: (request) => state.callTool(request),
                    releaseToolSession: (connectionId) =>
                        state.releaseToolSession(connectionId),
                    subscribe: events.subscribe,
                },
            },
            undefined,
            state.toolCalls.api,
            state.subscriptions,
        ),
        ...(options.extensionPorts ?? []),
    ]);
    return {
        host: asInstanceName(name),
        ports: fenceGeneration(ports, descriptor),
    };
}

function createInstanceRuntimeRouteModule(
    instance: Instance,
): ControlPortDefinition {
    return routeModule(INSTANCE_RUNTIME_PORT, {
        acquireReference: async (request) =>
            (await instance.worker.supervision.ownership.acquireReference(
                readString(request.payload, "reference", "instance.acquireReference"),
            )) as unknown as JsonValue,
        releaseReference: async (request) => {
            await instance.worker.supervision.ownership.releaseReference(
                readString(request.payload, "reference", "instance.releaseReference"),
            );
            return {};
        },
    });
}

function createEnvironmentRouteModule(instance: Instance): ControlPortDefinition {
    const environment = instance.worker.execution.environment;
    return routeModule(ENVIRONMENT_PORT, {
        prepareExtensionResource: async (request) =>
            (await environment.prepareExtensionResource({
                collection: readString(
                    request.payload,
                    "collection",
                    "environment.prepareExtensionResource",
                ),
                extensionId: readString(
                    request.payload,
                    "extensionId",
                    "environment.prepareExtensionResource",
                ),
            })) as unknown as JsonValue,
        prepareWorkspace: async (request) =>
            (await environment.prepareWorkspace(
                readString(
                    request.payload,
                    "workspace",
                    "environment.prepareWorkspace",
                ),
            )) as unknown as JsonValue,
        readAlerts: async (request) =>
            (await environment.readAlerts(
                readString(request.payload, "workspace", "environment.readAlerts"),
            )) as unknown as JsonValue,
        releaseAlerts: async (request) => {
            await environment.releaseAlerts(
                readString(
                    request.payload,
                    "workspace",
                    "environment.releaseAlerts",
                ),
            );
            return {};
        },
        touchAlerts: async (request) =>
            (await environment.touchAlerts(
                readString(request.payload, "workspace", "environment.touchAlerts"),
            )) as unknown as JsonValue,
        touchTemporaryDirectory: async (request) => {
            await environment.touchTemporaryDirectory(
                readString(
                    request.payload,
                    "path",
                    "environment.touchTemporaryDirectory",
                ),
            );
            return {};
        },
    });
}

function fenceGeneration(
    ports: readonly ControlPortDefinition[],
    descriptor: Instance,
): ControlPortDefinition[] {
    return ports.map((port) => ({
        ...port,
        operations: port.operations.map((operation) => ({
            ...operation,
            handle: async (request, context) => {
                const generation = descriptor.lifecycle.acquireLease();
                try {
                    return await operation.handle(request, context);
                } finally {
                    generation.release();
                }
            },
        })),
        ...(port.streams === undefined
            ? {}
            : {
                  streams: port.streams.map((operation) => ({
                      ...operation,
                      handle: async (stream, request, context) => {
                          const generation = descriptor.lifecycle.acquireLease();
                          try {
                              return await operation.handle(
                                  stream,
                                  request,
                                  context,
                              );
                          } finally {
                              generation.release();
                          }
                      },
                  })),
              }),
    }));
}

export function createProcessRouteModule(
    instance: Instance,
    state: InstanceState,
    subscriptions: ProcessSubscriptionManager,
): ControlPortDefinition {
    return routeModule(
        "process",
        {
            snapshot: () => {
                const snapshot = instance.worker.supervision.snapshot();
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot,
                    ...workerInfo(instance),
                } as unknown as JsonValue;
            },
            refresh: async () => {
                const snapshot =
                    await instance.worker.supervision.recovery.refreshStatus();
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot,
                    ...workerInfo(instance),
                } as unknown as JsonValue;
            },
            readLogs: async (request) =>
                (await state.tools.readLogs(
                    request.payload as never,
                )) as unknown as JsonValue,
            stop: async () => {
                const result =
                    await instance.worker.supervision.lifecycle.stop();
                instance.worker.supervision.ownership.clearOwned();
                return result as unknown as JsonValue;
            },
        },
        {
            start: async (stream) => {
                if (!instance.config.enabled)
                    throw createRemoteError({
                        code: runtimeErrorCodes.instanceConflict,
                        details: {
                            instance: instance.config.name,
                            operation: "start",
                        },
                        message: `Instance ${instance.config.name} is disabled.`,
                        retryable: false,
                    });
                const relay = new ProcessInteractiveSession();
                const offData = stream.onData((message) =>
                    relay.accept(message as ControlStreamMessage),
                );
                const offClose = stream.onClose(() => relay.closeInput());
                const offCancel = stream.onCancel(() => relay.closeInput());
                relay.bindOutput((chunk) =>
                    stream.send({ name: "output", payload: { chunk } }),
                );
                try {
                    const result =
                        await instance.worker.supervision.lifecycle.startInteractive(
                            relay,
                        );
                    instance.worker.supervision.ownership.markOwned();
                    await stream.close(result as unknown as JsonValue);
                } finally {
                    offData();
                    offClose();
                    offCancel();
                    relay.closeInput();
                }
            },
            subscribe: async (stream, request, context) =>
                await subscriptions.subscribe(
                    stream,
                    context,
                    instance.config.name,
                    instance.worker.supervision.state,
                    readProcessSubscriptionFromSeq(request.payload),
                    (event) =>
                        isProcessEventType(event.type)
                            ? (event as ProcessEvent)
                            : undefined,
                ),
        },
    );
}

function workerInfo(instance: Instance) {
    const handshake = instance.worker.supervision.handshake;
    return handshake === undefined
        ? {}
        : {
              worker: {
                  capabilities: handshake.capabilities,
                  platform: handshake.platform,
                  protocolVersion: handshake.protocolVersion,
                  version: handshake.workerVersion,
              },
          };
}

export function readProcessSubscriptionFromSeq(payload?: JsonValue): number {
    if (
        !isRecord(payload) ||
        typeof payload.fromSeq !== "number" ||
        !Number.isSafeInteger(payload.fromSeq) ||
        payload.fromSeq < 0
    ) {
        throw invalid(
            "process.subscribe requires a non-negative integer fromSeq.",
        );
    }
    return payload.fromSeq;
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
    payload: JsonValue | undefined,
    field: string,
    operation: string,
): string {
    if (!isRecord(payload) || typeof payload[field] !== "string")
        throw invalid(`${operation} requires string ${field}.`);
    return payload[field];
}

function invalid(message: string) {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}
