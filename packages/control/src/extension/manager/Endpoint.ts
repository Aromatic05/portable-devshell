import {
    createRemoteError,
    controlErrorCodes,
    type ExtensionRuntimeRecord,
    type JsonValue,
    type ControlPortContext,
    type ControlPortDefinition,
    type ExtensionSnapshot,
    type ExtensionChangeEvent,
    type MessageStream,
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../server/Route.js";
import { ExtensionChangeHub } from "./Change.js";
import type { ExtensionControlPort } from "./Port.js";

export function createExtensionRouteModule(
    port: ExtensionControlPort,
    control?: {
        changes: ExtensionChangeHub;
        snapshot(context: ControlPortContext): Promise<ExtensionSnapshot>;
    },
): ControlPortDefinition {
    const revisioned = () => requirePort(control, "Extension change stream is not configured.");
    return routeModule("extension", {
        snapshot: async (_request, context) =>
            await revisioned().snapshot(context) as unknown as JsonValue,
        list: async () => (await port.list()) as unknown as JsonValue,
        get: async (request) =>
            (await requireRecord(
                port,
                readExtensionId(request.payload),
            )) as unknown as JsonValue,
        reload: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.reload(id);
            return (await requireRecord(port, id)) as unknown as JsonValue;
        },
        enable: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.enable(id);
            return (await requireRecord(port, id)) as unknown as JsonValue;
        },
        disable: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.disable(id);
            return (await requireRecord(port, id)) as unknown as JsonValue;
        },
        install: async (request, context) => {
            requireLocalManagement(context);
            return (await port.install(
                readInstallSource(request.payload),
            )) as unknown as JsonValue;
        },
        remove: async (request, context) => {
            requireLocalManagement(context);
            const input = readRemove(request.payload);
            return (await port.remove(
                input.extensionId,
                input.purge,
            )) as unknown as JsonValue;
        },
    }, {
        subscribe: (stream, request) => {
            new ExtensionChangeStream(stream, revisioned().changes,
                readExtensionSubscriptionFromRevision(request.payload));
        },
    });
}

export function readExtensionSubscriptionFromRevision(payload?: JsonValue): number {
    const value = readRecord(payload, "extension.subscribe");
    assertOnlyKeys(value, ["fromRevision"], "extension.subscribe");
    if (typeof value.fromRevision !== "number" ||
        !Number.isSafeInteger(value.fromRevision) || value.fromRevision < 0)
        throw invalid("extension.subscribe requires a non-negative integer fromRevision.");
    return value.fromRevision;
}

class ExtensionChangeStream {
    #closed = false;
    readonly #stream: MessageStream;
    #tail: Promise<void> = Promise.resolve();
    readonly #unsubscribe: () => void;

    constructor(stream: MessageStream, hub: ExtensionChangeHub, fromRevision: number) {
        this.#stream = stream;
        const slice = hub.readSince(fromRevision);
        this.#unsubscribe = hub.onChange((change) =>
            this.#enqueue(() => this.#sendChange(change)),
        );
        stream.onClose(() => this.#close());
        stream.onCancel(() => this.#close());
        if (slice.kind === "gap") {
            this.#enqueue(async () => {
                if (this.#closed) return;
                await this.#stream.send({ name: "gap", payload: {
                    latestSeq: slice.latestRevision,
                    oldestAvailableSeq: slice.oldestAvailableRevision,
                    requestedFromSeq: fromRevision,
                } });
            });
        } else {
            for (const change of slice.changes)
                this.#enqueue(() => this.#sendChange(change));
        }
    }

    #enqueue(send: () => Promise<void>): void {
        this.#tail = this.#tail.then(send).catch(() => this.#close());
    }

    async #sendChange(change: ExtensionChangeEvent): Promise<void> {
        if (this.#closed) return;
        await this.#stream.send({ name: "event", payload: {
            extensionIds: [...change.extensionIds], revision: change.revision,
        }, seq: change.revision });
    }

    #close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#unsubscribe();
    }
}

async function requireRecord(
    port: ExtensionControlPort,
    id: string,
): Promise<ExtensionRuntimeRecord> {
    const record = (await port.list()).find((candidate) => candidate.id === id);
    if (record !== undefined) return record;
    throw createRemoteError({
        code: controlErrorCodes.extensionNotFound,
        details: { extensionId: id },
        message: `Extension ${id} is not installed.`,
        retryable: false,
    });
}

function requireLocalManagement(context: ControlPortContext): void {
    if (isLocalOwnerCli(context)) return;
    throw createRemoteError({
        code: controlErrorCodes.extensionAccessDenied,
        message:
            "Extension lifecycle mutations are restricted to the local owner CLI.",
        retryable: false,
    });
}

function isLocalOwnerCli(context: ControlPortContext): boolean {
    return context.peer === "cli" && context.subject?.kind === "local-owner";
}

function readExtensionId(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "Extension request");
    assertOnlyKeys(value, ["extensionId"], "Extension request");
    return readExtensionIdValue(value.extensionId);
}

function readInstallSource(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "extension.install");
    assertOnlyKeys(value, ["sourcePath"], "extension.install");
    if (typeof value.sourcePath === "string" && value.sourcePath.length > 0)
        return value.sourcePath;
    throw invalid("extension.install sourcePath must be a non-empty string.");
}

function readRemove(payload: JsonValue | undefined): {
    extensionId: string;
    purge: boolean;
} {
    const value = readRecord(payload, "extension.remove");
    assertOnlyKeys(value, ["extensionId", "purge"], "extension.remove");
    if (value.purge !== undefined && typeof value.purge !== "boolean") {
        throw invalid("extension.remove purge must be boolean.");
    }
    return {
        extensionId: readExtensionIdValue(value.extensionId),
        purge: value.purge === true,
    };
}

function readExtensionIdValue(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value))
        return value;
    throw invalid("extensionId must match [a-z][a-z0-9-]*.");
}

function readRecord(
    payload: JsonValue | undefined,
    operation: string,
): Record<string, JsonValue> {
    if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload)
    )
        return payload;
    throw invalid(`${operation} requires an object payload.`);
}

function assertOnlyKeys(
    value: Record<string, JsonValue>,
    keys: readonly string[],
    operation: string,
): void {
    const allowed = new Set(keys);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown !== undefined)
        throw invalid(`${operation} contains unknown field ${unknown}.`);
}

function invalid(message: string): Error {
    return createRemoteError({
        code: controlErrorCodes.extensionInvalid,
        message,
        retryable: false,
    });
}
