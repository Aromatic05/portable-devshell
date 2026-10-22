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
    type ToolCallProvenanceApi,
} from "@portable-devshell/shared";

import { createApprovalRouteModule } from "../approval/Public.js";
import { createGoalTaskRouteModule, createWaitTaskRouteModule } from "../task/Public.js";
import { createTerminalRouteModule } from "../terminal/Public.js";
import { ProcessInteractiveSession } from "./runtime/execution/Interactive.js";
import type { ProcessSubscriptionManager } from "@portable-devshell/shared";
import type { Instance } from "./model/Instance.js";
import type { InstanceState } from "./model/State.js";

const PROCESS_LOG_READ_LIMIT = 100;
const PROCESS_LOG_READ_MAX_BYTES = 1024 * 1024;
const LOG_TRUNCATION_MARKER = "\n... [log entry truncated for transport] ...\n";

export interface InstanceRouteOptions {
    descriptor: Instance;
    extensionPorts?: readonly ControlPortDefinition[];
    provenance?: ToolCallProvenanceApi;
    state: InstanceState;
    subscriptions: ProcessSubscriptionManager;
}

export function createInstanceHost(
    options: InstanceRouteOptions,
): ControlHostDefinition {
    const { descriptor, state, subscriptions } = options;
    const events = {
        cursor: () => descriptor.supervision.snapshot().lastSeq,
        subscribe: (fromSeq?: number) =>
            descriptor.supervision.state.subscribe(fromSeq),
    };
    const name = descriptor.config.name;
    const ports = mergeControlPortsByName([
        createInstanceRuntimeRouteModule(descriptor, subscriptions),
        createEnvironmentRouteModule(descriptor),
        createProcessRouteModule(descriptor, state, subscriptions),
        createApprovalRouteModule(
            { approval: state.approval.api, events, name },
            subscriptions,
        ),
        createTerminalRouteModule({
            backend: state.terminal.api,
            instance: name,
            onRetiring: (detach) => descriptor.lifecycle.onRetiring(detach),
            sessions: state.terminal.sessions.api,
        }),
        createGoalTaskRouteModule({ events, goal: state.task.api.goal }),
        createWaitTaskRouteModule(
            { events, name, wait: state.task.api.wait },
            subscriptions,
        ),
        createToolRouteModule(
            {
                name,
                worker: {
                    readWorkerTools: async () => state.toolDefinitions.list(),
                    prepareWorkspace: (workspace, connectionId) =>
                        state.tools.openSession(workspace, connectionId),
                    readToolCalls: (query) => state.tools.readToolCalls(query),
                    readToolCallFailureSummary: (sinceMs, untilMs) =>
                        state.tools.readToolCallFailureSummary(sinceMs, untilMs),
                    dispatchToolCall: (request) => state.target().dispatch(request),
                    releaseToolSession: (connectionId) =>
                        state.tools.releaseSession(connectionId),
                    subscribe: events.subscribe,
                },
            },
            options.provenance,
            state.toolCalls.api,
            subscriptions,
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
    subscriptions: ProcessSubscriptionManager,
): ControlPortDefinition {
    return routeModule(
        INSTANCE_RUNTIME_PORT,
        {
            acquireReference: async (request) =>
                (await instance.supervision.ownership.acquireReference(
                    readString(
                        request.payload,
                        "reference",
                        "instance.acquireReference",
                    ),
                )) as unknown as JsonValue,
            appendEvent: async (request) => {
                const payload = readRecord(
                    request.payload,
                    "instance.appendEvent",
                );
                await instance.supervision.state.appendEvent(
                    readString(
                        request.payload,
                        "type",
                        "instance.appendEvent",
                    ),
                    payload.data,
                );
                return {};
            },
            readEvents: (request) =>
                instance.supervision.state.subscribe(
                    readFromSeq(request.payload, "instance.readEvents"),
                ) as unknown as JsonValue,
            releaseReference: async (request) => {
                await instance.supervision.ownership.releaseReference(
                    readString(
                        request.payload,
                        "reference",
                        "instance.releaseReference",
                    ),
                );
                return {};
            },
        },
        {
            subscribeEvents: async (stream, request, context) =>
                await subscriptions.subscribe(
                    stream,
                    context,
                    instance.config.name,
                    instance.supervision.state,
                    readFromSeq(request.payload, "instance.subscribeEvents"),
                ),
        },
    );
}

function createEnvironmentRouteModule(instance: Instance): ControlPortDefinition {
    const environment = instance.environment;
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
                typeof request.payload === "object" && request.payload !== null &&
                    !Array.isArray(request.payload) &&
                    typeof request.payload.temporaryDirectory === "string"
                    ? request.payload.temporaryDirectory : undefined,
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
                const snapshot = instance.supervision.snapshot();
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot,
                    ...workerInfo(instance),
                } as unknown as JsonValue;
            },
            refresh: async () => {
                const snapshot =
                    await instance.supervision.recovery.refreshStatus();
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot,
                    ...workerInfo(instance),
                } as unknown as JsonValue;
            },
            readLogs: async (request) => {
                const query = (request.payload ?? {}) as {
                    limit?: number;
                    maxDecodedBytes?: number;
                };
                const maxDecodedBytes = Math.min(
                    query.maxDecodedBytes ?? PROCESS_LOG_READ_MAX_BYTES,
                    PROCESS_LOG_READ_MAX_BYTES,
                );
                const logs = await state.tools.readLogs({
                    ...query,
                    limit: Math.min(query.limit ?? PROCESS_LOG_READ_LIMIT, PROCESS_LOG_READ_LIMIT),
                    maxDecodedBytes,
                });
                return logs.map((entry) => {
                    const bytes = Buffer.from(entry.message, "utf8");
                    if (bytes.length <= maxDecodedBytes) return entry;
                    const marker = maxDecodedBytes > Buffer.byteLength(LOG_TRUNCATION_MARKER, "utf8")
                        ? LOG_TRUNCATION_MARKER : "";
                    const available = maxDecodedBytes - Buffer.byteLength(marker, "utf8");
                    const head = Math.floor(available / 2);
                    return {
                        ...entry,
                        message: bytes.subarray(0, head).toString("utf8") +
                            marker +
                            bytes.subarray(bytes.length - (available - head)).toString("utf8"),
                        truncated: true,
                    };
                }) as unknown as JsonValue;
            },
            stop: async () => {
                const result =
                    await instance.supervision.lifecycle.stop();
                instance.supervision.ownership.clearOwned();
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
                        await instance.supervision.lifecycle.startInteractive(
                            relay,
                        );
                    instance.supervision.ownership.markOwned();
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
                    instance.supervision.state,
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
    const handshake = instance.supervision.handshake;
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
    return readFromSeq(payload, "process.subscribe");
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

function readRecord(
    payload: JsonValue | undefined,
    operation: string,
): Record<string, JsonValue> {
    if (!isRecord(payload)) throw invalid(`${operation} requires an object.`);
    return payload;
}

function readFromSeq(
    payload: JsonValue | undefined,
    operation: string,
): number {
    if (
        !isRecord(payload) ||
        typeof payload.fromSeq !== "number" ||
        !Number.isSafeInteger(payload.fromSeq) ||
        payload.fromSeq < 0
    )
        throw invalid(`${operation} requires a non-negative integer fromSeq.`);
    return payload.fromSeq;
}

function invalid(message: string) {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}
