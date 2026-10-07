import type {
    InstanceListEntry,
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";
import {
    requirePort,
    routeModule,
    asInstanceName,
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";

import type { InstanceChange } from "./Change.js";
import type { InstanceConfigRouteModuleOptions } from "./Api.js";

export function createInstanceConfigRouteModule(
    options: InstanceConfigRouteModuleOptions,
): ControlPortDefinition {
    const create = () =>
        requirePort(options.create, "Instance creation is not available.");
    const editor = () =>
        requirePort(options.editor, "Config editing is not available.");
    return routeModule(
        "instance",
        {
            acquireInstanceReference: async (request) => {
                const input = readInstanceReference(request.payload);
                const instance = options.registry.get(input.instanceName);
                if (instance === undefined)
                    throw createRemoteError({
                        code: controlErrorCodes.instanceNotFound,
                        details: { instance: input.instanceName },
                        message: `Instance ${input.instanceName} was not found.`,
                        retryable: false,
                    });
                const lease = await instance.ownership.acquireReference(input.reference);
                return lease.snapshot as unknown as JsonValue;
            },
            listInstances: () => readInstances(options) as never,
            snapshotInstances: () => {
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
            createInstanceSchema: () => create().getSchema() as never,
            validateInstanceCreate: (request) =>
                create().validateDraft(request.payload) as never,
            createInstance: async (request) =>
                (await create().createInstance(request.payload)) as never,
            enableInstance: async (request) =>
                await editor().enableInstance(request.payload),
            disableInstance: async (request) =>
                await editor().disableInstance(request.payload),
            deleteInstance: async (request) =>
                await editor().deleteInstance(request.payload),
            releaseInstanceReference: async (request) => {
                const input = readInstanceReference(request.payload);
                await options.registry
                    .get(input.instanceName)
                    ?.ownership.releaseReference(input.reference);
                return {};
            },
            updateInstance: async (request) =>
                await editor().updateInstanceConfig(request.payload),
        },
        {
            subscribeInstances: async (stream, request) => {
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

function readInstanceReference(payload?: JsonValue): {
    instanceName: string;
    reference: string;
} {
    if (!isRecord(payload))
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "instance reference operation requires an object payload.",
            retryable: false,
        });
    const instanceName = payload.instanceName;
    const reference = payload.reference;
    if (
        typeof instanceName !== "string" ||
        instanceName.trim().length === 0 ||
        typeof reference !== "string" ||
        reference.trim().length === 0
    )
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "instanceName and reference must be non-empty strings.",
            retryable: false,
        });
    return { instanceName: instanceName.trim(), reference: reference.trim() };
}

function readInstances(
    options: InstanceConfigRouteModuleOptions,
): InstanceListEntry[] {
    const configured =
        options.configuredInstances?.() ??
        options.registry.list().map((descriptor) => ({
            enabled: true,
            mcp: { enabled: descriptor.config.mcpEnabled },
            name: descriptor.config.name,
        }));
    return configured.map((instance): InstanceListEntry => {
        return {
            enabled: instance.enabled,
            mcpEnabled: instance.mcp.enabled,
            name: instance.name,
            snapshot: inactiveSnapshot(instance.name),
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
                "instance.subscribeInstances requires a non-negative integer fromRevision.",
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
