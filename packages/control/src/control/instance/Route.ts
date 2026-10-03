import type {
    ControlConfig,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    InstanceListEntry,
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";
import {
    asInstanceName,
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../server/Route.js";
import type { InstanceChange, InstanceChangeHub } from "./Change.js";
import type { InstanceRegistry } from "./registry/Registry.js";

export interface InstanceCreatePort {
    createInstance(params?: JsonValue): Promise<InstanceCreateResult>;
    getSchema(): InstanceCreateSchema;
    validateDraft(params?: JsonValue): InstanceCreateSummary;
}

export interface InstanceEditorPort {
    deleteInstance(params?: JsonValue): Promise<JsonValue>;
    disableInstance(params?: JsonValue): Promise<JsonValue>;
    enableInstance(params?: JsonValue): Promise<JsonValue>;
}

export interface InstanceRouteModuleOptions {
    /**
     * Persistent revision feed signalled by composition after the registry or
     * a list-affecting Config commit has been applied.
     */
    changes: InstanceChangeHub;
    configuredInstances?: () => readonly ControlConfig["instances"][number][];
    create?: InstanceCreatePort;
    editor?: InstanceEditorPort;
    registry: InstanceRegistry;
}

export function createInstanceRouteModule(
    options: InstanceRouteModuleOptions,
): ControlPortDefinition {
    const create = () =>
        requirePort(options.create, "Instance creation is not available.");
    const editor = () =>
        requirePort(options.editor, "Config editing is not available.");
    return routeModule(
        "instance",
        {
            list: () => readInstances(options) as never,
            snapshot: () => {
                // Stable read: the envelope's revision must label exactly the
                // list we returned, so retry if the feed advanced mid-read.
                for (;;) {
                    const revision = options.changes.revision;
                    const instances = readInstances(options);
                    if (options.changes.revision === revision) {
                        return { instances, revision } as never;
                    }
                }
            },
            createSchema: () => create().getSchema() as never,
            validateCreate: (request) =>
                create().validateDraft(request.payload) as never,
            create: async (request) =>
                (await create().createInstance(request.payload)) as never,
            enable: async (request) =>
                await editor().enableInstance(request.payload),
            disable: async (request) =>
                await editor().disableInstance(request.payload),
            delete: async (request) =>
                await editor().deleteInstance(request.payload),
        },
        {
            subscribe: async (stream, request) => {
                const fromRevision = readSubscribeFromRevision(request.payload);
                const replay = options.changes.replay(fromRevision);
                if (replay.kind === "gap") {
                    await stream.send({
                        name: "gap",
                        payload: {
                            latestSeq: replay.gap.lastRevision,
                            oldestAvailableSeq:
                                replay.gap.oldestAvailableRevision,
                            requestedFromSeq: replay.gap.requestedFromRevision,
                        } as never,
                        seq: replay.gap.lastRevision,
                    });
                    return;
                }

                // Register the live listener synchronously with the replay so
                // a change cannot slip between the two. Live events are queued
                // until the seed replay has been written, preserving order.
                const pending: InstanceChange[] = [];
                let seeded = false;
                let flushing = false;
                let unsubscribe: () => void = () => undefined;
                const flush = async (): Promise<void> => {
                    if (!seeded || flushing) return;
                    flushing = true;
                    try {
                        while (pending.length > 0) {
                            const change = pending.shift()!;
                            await stream.send({
                                name: "event",
                                payload: toChangePayload(change) as never,
                                seq: change.revision,
                            });
                        }
                    } catch {
                        // A failed write cannot be replayed on this stream;
                        // detach so the client reconnects and gap-recovers.
                        pending.length = 0;
                        unsubscribe();
                    } finally {
                        flushing = false;
                    }
                };
                unsubscribe = options.changes.onChange((change) => {
                    if (change.revision <= replay.lastRevision) return;
                    pending.push(change);
                    void flush();
                });
                stream.onClose(unsubscribe);
                stream.onCancel(unsubscribe);
                await stream.send({
                    name: "seed",
                    payload: {
                        events: replay.changes.map(toChangePayload),
                        lastRevision: replay.lastRevision,
                    } as never,
                });
                seeded = true;
                await flush();
            },
        },
    );
}

function readInstances(
    options: InstanceRouteModuleOptions,
): InstanceListEntry[] {
    const configured =
        options.configuredInstances?.() ??
        options.registry.list().map((descriptor) => ({
            enabled: true,
            mcp: { enabled: descriptor.mcpEnabled },
            name: descriptor.name,
        }));
    return configured.map((instance): InstanceListEntry => {
        const descriptor = options.registry.get(instance.name);
        return {
            enabled: instance.enabled,
            ...(descriptor?.worker.handshake?.homeDirectory === undefined
                ? {}
                : {
                      homeDirectory: descriptor.worker.handshake.homeDirectory,
                  }),
            mcpEnabled: instance.mcp.enabled,
            name: instance.name,
            snapshot:
                descriptor?.worker.snapshot() ??
                inactiveSnapshot(instance.name),
        };
    });
}

function toChangePayload(change: InstanceChange): JsonValue {
    return { kind: change.kind, revision: change.revision };
}

function readSubscribeFromRevision(payload?: JsonValue): number {
    if (
        !isRecord(payload) ||
        typeof payload.fromRevision !== "number" ||
        !Number.isSafeInteger(payload.fromRevision) ||
        payload.fromRevision < 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message:
                "instance.subscribe requires a non-negative integer fromRevision.",
            retryable: false,
        });
    }
    return payload.fromRevision;
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inactiveSnapshot(name: string): InstanceListEntry["snapshot"] {
    return {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 0,
        name: asInstanceName(name),
        ready: false,
        status: "stopped",
    };
}
