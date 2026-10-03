import { ContextChangeHub, type ContextCommittedChange } from "./Registry/Change.js";
import type { ContextSnapshot } from "../../../shared/src/workspace/context/Revision.js";
import type { MessageStream } from "@portable-devshell/shared";
import type {
    McpContextRecord,
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";
import {
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../server/Route.js";

export interface ContextAdminPort {
    readonly changes: ContextChangeHub;
    snapshot(): Promise<ContextSnapshot>;
    referenceInstance(
        ctxId: string,
        instance: string,
    ): Promise<{ current: boolean; handle?: string } | undefined>;
    disable(ctxId: string): Promise<McpContextRecord>;
    list(): Promise<McpContextRecord[]>;
    renew(ctxId: string): Promise<McpContextRecord>;
    validateForInstance(
        ctxId: string,
        instance: string,
    ): Promise<McpContextRecord>;
}

export function createContextRouteModule(
    port: ContextAdminPort | (() => ContextAdminPort | undefined) | undefined,
): ControlPortDefinition {
    const admin = () =>
        requirePort(
            typeof port === "function" ? port() : port,
            "Contexts are not available.",
        );
    return routeModule("context", {
        snapshot: async () => (await admin().snapshot()) as unknown as JsonValue,
        list: async () => (await admin().list()) as unknown as JsonValue,
        disable: async (request) =>
            (await admin().disable(
                readCtxId(request.payload),
            )) as unknown as JsonValue,
        renew: async (request) =>
            (await admin().renew(
                readCtxId(request.payload),
            )) as unknown as JsonValue,
    }, {
        subscribe: (stream, request) => {
            new ContextChangeStream(stream, admin().changes, readContextSubscriptionFromRevision(request.payload));
        },
    });
}

function readCtxId(value: JsonValue | undefined): string {
    const ctxId =
        typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, JsonValue>).ctxId
            : undefined;
    if (typeof ctxId !== "string" || ctxId.trim().length === 0) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "context operation requires a ctxId string.",
            retryable: false,
        });
    }
    return ctxId;
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
