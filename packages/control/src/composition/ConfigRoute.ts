import {
    createRemoteError,
    controlErrorCodes,
    type ControlPortDefinition,
    type JsonValue,
    type MessageStream,
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../server/Route.js";
import { ConfigChangeHub, type ConfigCommittedChange } from "../config/change/Config.js";

export interface ConfigEditorPort {
    getConfigView(): JsonValue;
    updateConfig(params?: JsonValue): Promise<JsonValue>;
    updateMcpConfig(params?: JsonValue): Promise<JsonValue>;
    updateWebConfig(params?: JsonValue): Promise<JsonValue>;
    validateConfigDraft(params?: JsonValue): JsonValue;
}

const SNAPSHOT_RETRIES = 8;

export function createConfigRouteModule(
    service: ConfigEditorPort | undefined,
    changes: ConfigChangeHub,
): ControlPortDefinition {
    const config = () =>
        requirePort(service, "Config editing is not available.");
    return routeModule(
        "config",
        {
            get: () => config().getConfigView(),
            snapshot: () => readConfigSnapshot(config(), changes),
            validate: (request) =>
                config().validateConfigDraft(request.payload),
            update: async (request) =>
                await config().updateConfig(request.payload),
            updateMcpEndpoint: async (request) =>
                await config().updateMcpConfig(request.payload),
            updateWeb: async (request) =>
                await config().updateWebConfig(request.payload),
        },
        {
            subscribe: (stream, request) => {
                new ConfigChangeStream(
                    stream,
                    changes,
                    readConfigSubscriptionFromRevision(request.payload),
                );
            },
        },
    );
}

/**
 * Race-safe snapshot: a committed change is only consistent with the view read
 * between its revision observations. Retries until the view was read with no
 * commit interleaved between the two revision reads.
 */
export function readConfigSnapshot(
    service: ConfigEditorPort,
    changes: ConfigChangeHub,
): JsonValue {
    for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt += 1) {
        const before = changes.revision;
        const view = service.getConfigView();
        const after = changes.revision;
        if (before === after) {
            return { revision: after, view } as unknown as JsonValue;
        }
    }
    return {
        revision: changes.revision,
        view: service.getConfigView(),
    } as unknown as JsonValue;
}

export function readConfigSubscriptionFromRevision(
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
                "config.subscribe requires a non-negative integer fromRevision.",
            retryable: false,
        });
    }
    return payload.fromRevision;
}

interface ConfigStreamGapPayload {
    readonly latestSeq: number;
    readonly oldestAvailableSeq: number;
    readonly requestedFromSeq: number;
}

/**
 * One server-side Config subscriber. Replays the buffered slice that the
 * client has not seen and then forwards live commits in revision order. Sends
 * are serialized so a slow transport cannot reorder revisions. A requested
 * revision that is no longer buffered yields a non-terminal gap descriptor;
 * the client recovers with an authoritative snapshot and resumes one past it.
 */
class ConfigChangeStream {
    #closed = false;
    readonly #stream: MessageStream;
    #tail: Promise<void> = Promise.resolve();
    #unsubscribe: () => void;

    constructor(
        stream: MessageStream,
        hub: ConfigChangeHub,
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

    #sendChange(change: ConfigCommittedChange): Promise<void> {
        if (this.#closed) return Promise.resolve();
        return this.#stream.send({
            name: "event",
            payload: { paths: [...change.paths], revision: change.revision },
            seq: change.revision,
        });
    }

    #sendGap(gap: ConfigStreamGapPayload): Promise<void> {
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
