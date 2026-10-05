import {
    asInstanceName,
    createRemoteError,
    controlErrorCodes,
    isProcessEventType,
    runtimeErrorCodes,
    type ProcessEvent,
    type JsonValue,
    type ControlStreamMessage,
    mergeControlPortsByName,
    type ControlHostDefinition,
    type ControlPortDefinition,
} from "@portable-devshell/shared";

import { createApprovalRouteModule } from "../approval/transport/Route.js";
import { requirePort, routeModule } from "../Port.js";
import { ProcessInteractiveSession } from "./runtime/execution/Interactive.js";
import type { WorkerInstance } from "./runtime/index.js";
import type { ReverseCredentials } from "./transport/endpoint/channel/reverse/credential/Credentials.js";
import type { ProcessSubscriptionManager } from "./runtime/supervision/Subscription.js";
import { createTerminalRouteModule } from "../terminal/Route.js";
import type { TerminalSessionService } from "../terminal/Service.js";
import type { Instance } from "./Instance.js";
import type { InstanceRegistry } from "./Registry.js";
import type { InstanceEventSource } from "./runtime/supervision/Event.js";

export interface InstanceRouteOptions {
    descriptor: Instance;
    extensionPorts?: readonly ControlPortDefinition[];
    registry: InstanceRegistry;
    subscriptions: ProcessSubscriptionManager;
    terminalMaxUnackedBytes?: number;
    terminals: TerminalSessionService;
}

export function createInstanceHost(
    options: InstanceRouteOptions,
): ControlHostDefinition {
    const { descriptor } = options;
    const events: InstanceEventSource = {
        cursor: () => descriptor.worker.snapshot().lastSeq,
        subscribe: (fromSeq) => descriptor.worker.subscribe(fromSeq),
    };
    const ports = mergeControlPortsByName([
        createProcessRouteModule(
            {
                enabled: descriptor.enabled,
                name: descriptor.name,
                worker: descriptor.worker,
            },
            options.registry,
            options.subscriptions,
        ),
        ...(options.extensionPorts ?? []),
        createApprovalRouteModule(
            {
                approval: descriptor.approval,
                events,
                name: descriptor.name,
            },
            options.subscriptions,
        ),
        createTerminalRouteModule({
            backend: descriptor.terminal,
            instance: descriptor.name,
            ...(options.terminalMaxUnackedBytes === undefined
                ? {}
                : { maxUnackedBytes: options.terminalMaxUnackedBytes }),
            sessions: options.terminals,
        }),
    ]);
    return {
        host: asInstanceName(descriptor.name),
        ports: fenceGeneration(ports, descriptor),
    };
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
                const generation = descriptor.acquireLease();
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
                          const generation = descriptor.acquireLease();
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

export interface ProcessRouteInstancePort {
    enabled: boolean;
    name: string;
    worker: Pick<
        WorkerInstance,
        | "refreshStatus"
        | "snapshot"
        | "startInteractive"
        | "stop"
        | "subscribe"
    >;
}

export function createProcessRouteModule(
    instance: ProcessRouteInstancePort,
    registry: InstanceRegistry,
    subscriptions: ProcessSubscriptionManager,
): ControlPortDefinition {
    return routeModule(
        "process",
        {
            snapshot: () => {
                const snapshot = instance.worker.snapshot();
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot,
                } as unknown as JsonValue;
            },
            refresh: async () => {
                const snapshot = await instance.worker.refreshStatus();
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot,
                } as unknown as JsonValue;
            },
            stop: async () => {
                const result = await instance.worker.stop();
                registry.get(instance.name)?.clearOwned();
                if (!instance.enabled) {
                    await registry.remove(instance.name);
                }
                return result as unknown as JsonValue;
            },
        },
        {
            start: async (stream) => {
                if (!instance.enabled)
                    throw createRemoteError({
                        code: runtimeErrorCodes.instanceConflict,
                        details: {
                            instance: instance.name,
                            operation: "start",
                        },
                        message: `Instance ${instance.name} is disabled.`,
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
                    const result = await instance.worker.startInteractive(relay);
                    registry.get(instance.name)?.markOwned();
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
                    instance.name,
                    instance.worker,
                    readProcessSubscriptionFromSeq(request.payload),
                    (event) =>
                        isProcessEventType(event.type)
                            ? (event as ProcessEvent)
                            : undefined,
                ),
        },
    );
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

function invalid(message: string) {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}

export function createConnectionRouteModule(
    service?: ReverseCredentials,
): ControlPortDefinition {
    const connection = () =>
        requirePort(service, "Connection management is not available.");
    return routeModule("connection", {
        createCode: async (request) =>
            (await connection().createDeviceCode(
                readReverseInstanceName(request.payload),
            )) as never,
        rotateToken: async (request) =>
            (await connection().rotateDeviceToken(
                readReverseInstanceName(request.payload),
            )) as never,
        revokeToken: async (request) =>
            (await connection().revokeDeviceToken(
                readReverseInstanceName(request.payload),
            )) as never,
    });
}

function readReverseInstanceName(params?: JsonValue): string {
    if (
        !isRecord(params) ||
        typeof params.instance !== "string" ||
        params.instance.length === 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "Reverse connection operation requires instance.",
            retryable: false,
        });
    }
    return params.instance;
}
