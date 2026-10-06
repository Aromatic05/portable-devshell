// Global Artifact event log. Artifact state is control-wide (shares and
// transfers are not scoped to a single instance), so the log owns one monotonic
// sequence for every logical Share/Transfer event, independent of per-instance
// Runtime streams. The log keeps a bounded replay window and notifies live
// subscribers; the artifact route uses both to serve cursor-resumable streams.

import type { ArtifactEventType, JsonValue } from "@portable-devshell/shared";

export const DEFAULT_ARTIFACT_EVENT_HISTORY_LIMIT = 256;

export type ArtifactEventRecorder = (
    instance: string,
    type: ArtifactEventType,
    data?: JsonValue,
) => void;

export interface ArtifactLogEvent {
    at: string;
    data?: JsonValue;
    instance: string;
    seq: number;
    type: ArtifactEventType;
}

export type ArtifactEventRead =
    | { events: ArtifactLogEvent[]; kind: "events"; lastSeq: number }
    | { kind: "gap"; lastSeq: number; nextSeq: number };

export class ArtifactEventLog {
    readonly #events: ArtifactLogEvent[] = [];
    readonly #historyLimit: number;
    readonly #listeners = new Set<() => void>();
    #closed = false;
    #lastSeq = 0;

    constructor(historyLimit: number) {
        if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) {
            throw new TypeError(
                "Artifact event history limit must be a non-negative safe integer.",
            );
        }
        this.#historyLimit = historyLimit;
    }

    get closed(): boolean {
        return this.#closed;
    }

    get lastSeq(): number {
        return this.#lastSeq;
    }

    /** Reopens an empty log while keeping the sequence monotonic. */
    reset(): void {
        this.#closed = false;
        this.#events.length = 0;
    }

    /** Stops every live subscriber; the log can be reset to serve again. */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of [...this.#listeners]) listener();
    }

    record(
        instance: string,
        type: ArtifactEventType,
        data?: JsonValue,
    ): ArtifactLogEvent {
        const event: ArtifactLogEvent = {
            at: new Date().toISOString(),
            ...(data === undefined ? {} : { data }),
            instance,
            seq: ++this.#lastSeq,
            type,
        };
        this.#events.push(event);
        if (this.#events.length > this.#historyLimit) {
            this.#events.splice(0, this.#events.length - this.#historyLimit);
        }
        for (const listener of [...this.#listeners]) listener();
        return event;
    }

    read(fromSeq: number): ArtifactEventRead {
        const requested = Math.max(1, fromSeq);
        const oldest =
            this.#events.length === 0
                ? this.#lastSeq + 1
                : this.#events[0]!.seq;
        if (requested < oldest) {
            return {
                kind: "gap",
                lastSeq: this.#lastSeq,
                nextSeq: oldest,
            };
        }
        return {
            events: this.#events
                .filter((event) => event.seq >= requested)
                .map((event) => structuredClone(event)),
            kind: "events",
            lastSeq: this.#lastSeq,
        };
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
}
