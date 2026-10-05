import {
    ContextChangeHub,
    type ContextCommittedChange,
} from "./registry/Change.js";
import type { ContextRecordSourcePort } from "./service/index.js";
import type { MessageStream } from "@portable-devshell/shared";
import type {
    ContextResolveInput,
    ContextRecord,
    ContextQuery,
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";
import {
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../Port.js";

type ContextAdminRegistryPort = Pick<
    ContextRecordSourcePort,
    | "changes"
    | "list"
    | "referenceInstance"
    | "snapshot"
    | "validateForInstance"
>;

export interface ContextAdminPort {
    readonly registry: ContextAdminRegistryPort;
    disable(ctxId: string): Promise<ContextRecord>;
    detachInstance(instance: string): Promise<ContextRecord[]>;
    reconcileInstance(instance: string): Promise<void>;
    renew(ctxId: string): Promise<ContextRecord>;
    resolve(input: ContextResolveInput): Promise<ContextRecord>;
}

export function createContextRouteModule(
    port: ContextAdminPort | (() => ContextAdminPort | undefined) | undefined,
): ControlPortDefinition {
    const admin = () =>
        requirePort(
            typeof port === "function" ? port() : port,
            "Contexts are not available.",
        );
    return routeModule(
        "context",
        {
            snapshot: async () =>
                (await admin().registry.snapshot()) as unknown as JsonValue,
            list: async (request) =>
                (await admin().registry.list(
                    readContextQuery(request.payload),
                )) as unknown as JsonValue,
            disable: async (request) =>
                (await admin().disable(
                    readCtxId(request.payload),
                )) as unknown as JsonValue,
            renew: async (request) =>
                (await admin().renew(
                    readCtxId(request.payload),
                )) as unknown as JsonValue,
            resolve: async (request) =>
                (await admin().resolve(
                    readContextResolveInput(request.payload),
                )) as unknown as JsonValue,
            referenceInstance: async (request) => {
                const { ctxId, instance } = readContextInstanceTarget(
                    request.payload,
                );
                return (await admin().registry.referenceInstance(
                    ctxId,
                    instance,
                )) as unknown as JsonValue;
            },
            validateForInstance: async (request) => {
                const { ctxId, instance } = readContextInstanceTarget(
                    request.payload,
                );
                return (await admin().registry.validateForInstance(
                    ctxId,
                    instance,
                )) as unknown as JsonValue;
            },
            detachInstance: async (request) =>
                (await admin().detachInstance(
                    readInstance(request.payload),
                )) as unknown as JsonValue,
            reconcileInstance: async (request) => {
                await admin().reconcileInstance(readInstance(request.payload));
                return {};
            },
        },
        {
            subscribe: (stream, request) => {
                new ContextChangeStream(
                    stream,
                    admin().registry.changes,
                    readContextSubscriptionFromRevision(request.payload),
                );
            },
        },
    );
}

function readCtxId(value: JsonValue | undefined): string {
    const ctxId = isRecord(value) ? value.ctxId : undefined;
    if (typeof ctxId !== "string" || ctxId.trim().length === 0) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "context operation requires a ctxId string.",
            retryable: false,
        });
    }
    return ctxId;
}

function readInstance(value: JsonValue | undefined): string {
    const instance = isRecord(value) ? value.instance : undefined;
    if (typeof instance !== "string" || instance.trim().length === 0)
        throw invalidContextRequest(
            "context operation requires an instance string.",
        );
    return instance;
}

function readContextInstanceTarget(value: JsonValue | undefined): {
    ctxId: string;
    instance: string;
} {
    return {
        ctxId: readCtxId(value),
        instance: readInstance(value),
    };
}

function readContextQuery(value: JsonValue | undefined): ContextQuery {
    if (value === undefined) return {};
    return readObject(value, "context.list") as unknown as ContextQuery;
}

function readContextResolveInput(
    value: JsonValue | undefined,
): ContextResolveInput {
    return readObject(
        value,
        "context.resolve",
    ) as unknown as ContextResolveInput;
}

function readObject(
    value: JsonValue | undefined,
    operation: string,
): Record<string, JsonValue> {
    if (isRecord(value)) return value;
    throw invalidContextRequest(`${operation} requires an object.`);
}

function invalidContextRequest(message: string) {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}

export function readContextSubscriptionFromRevision(
    payload?: JsonValue,
): number {
    if (
        !isRecord(payload) ||
        typeof payload.fromRevision !== "number" ||
        !Number.isSafeInteger(payload.fromRevision) ||
        payload.fromRevision < 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message:
                "context.subscribe requires a non-negative integer fromRevision.",
            retryable: false,
        });
    }
    return payload.fromRevision;
}

interface ContextStreamGapPayload {
    readonly latestSeq: number;
    readonly oldestAvailableSeq: number;
    readonly requestedFromSeq: number;
}

class ContextChangeStream {
    #closed = false;
    readonly #stream: MessageStream;
    #tail: Promise<void> = Promise.resolve();
    #unsubscribe: () => void;

    constructor(
        stream: MessageStream,
        hub: ContextChangeHub,
        fromRevision: number,
    ) {
        this.#stream = stream;
        const slice = hub.readSince(fromRevision);
        this.#unsubscribe = hub.onChange((change) =>
            this.#enqueue(() => this.#sendChange(change)),
        );
        const close = () => this.#close();
        stream.onClose(close);
        stream.onCancel(close);
        if (slice.kind === "gap") {
            this.#enqueue(() =>
                this.#sendGap({
                    latestSeq: slice.latestRevision,
                    oldestAvailableSeq: slice.oldestAvailableRevision,
                    requestedFromSeq: fromRevision,
                }),
            );
            return;
        }
        for (const change of slice.changes) {
            this.#enqueue(() => this.#sendChange(change));
        }
    }

    #enqueue(send: () => Promise<void>): void {
        this.#tail = this.#tail.then(send).catch(() => this.#close());
    }

    #sendChange(change: ContextCommittedChange): Promise<void> {
        if (this.#closed) return Promise.resolve();
        return this.#stream.send({
            name: "event",
            payload: { ctxIds: [...change.ctxIds], revision: change.revision },
            seq: change.revision,
        });
    }

    #sendGap(gap: ContextStreamGapPayload): Promise<void> {
        if (this.#closed) return Promise.resolve();
        return this.#stream.send({ name: "gap", payload: { ...gap } });
    }

    #close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#unsubscribe();
    }
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
