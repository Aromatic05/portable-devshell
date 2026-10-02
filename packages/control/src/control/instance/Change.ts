// Persistent, injectable revision feed for the Control instance registry.
//
// The feed is a monotonic revision counter plus a bounded replay buffer. It is
// deliberately blind to where a change came from: composition owns the feed
// and signals it only after the instance registry or a list-affecting Config
// commit has been applied. The revision therefore labels an already-visible
// authoritative list snapshot, so a subscriber that resumes at revision R + 1
// observes every later change exactly once.
//
// The replay buffer is bounded so it cannot grow without limit. A subscriber
// that asks to resume before the oldest retained revision gets an explicit gap
// and must re-read the authoritative list before resuming.

export type InstanceChangeKind = "config" | "registry";

export interface InstanceChange {
    readonly kind: InstanceChangeKind;
    readonly revision: number;
}

export interface InstanceChangeGap {
    readonly lastRevision: number;
    readonly oldestAvailableRevision: number;
    readonly requestedFromRevision: number;
}

export type InstanceChangeReplay =
    | {
          readonly changes: readonly InstanceChange[];
          readonly kind: "replay";
          readonly lastRevision: number;
      }
    | {
          readonly gap: InstanceChangeGap;
          readonly kind: "gap";
      };

export interface InstanceChangeHubOptions {
    /** Maximum number of recent revisions retained for replay. */
    readonly replayLimit?: number;
}

export class InstanceChangeHub {
    readonly #changes: InstanceChange[] = [];
    readonly #listeners = new Set<(change: InstanceChange) => void>();
    readonly #replayLimit: number;
    #revision = 0;

    constructor(options: InstanceChangeHubOptions = {}) {
        this.#replayLimit = Math.max(1, options.replayLimit ?? 256);
    }

    /** Latest published revision; 0 before any change. */
    get revision(): number {
        return this.#revision;
    }

    /**
     * Advances the revision and notifies live subscribers. Callers must apply
     * the underlying change first so the new revision always labels the
     * already-visible state.
     */
    publish(kind: InstanceChangeKind): InstanceChange {
        const change = Object.freeze({ kind, revision: ++this.#revision });
        this.#changes.push(change);
        if (this.#changes.length > this.#replayLimit) {
            this.#changes.splice(0, this.#changes.length - this.#replayLimit);
        }
        for (const listener of [...this.#listeners]) {
            try {
                listener(change);
            } catch {
                // A committed change cannot be rolled back by an observer.
            }
        }
        return change;
    }

    /**
     * Replays every retained change at or after `fromRevision`. `fromRevision`
     * is the next revision the caller expects; a value below the oldest
     * retained revision is reported as a gap.
     */
    replay(fromRevision: number): InstanceChangeReplay {
        const requested = Math.max(1, Math.trunc(fromRevision));
        const oldest = this.#changes[0]?.revision ?? this.#revision + 1;
        if (requested < oldest) {
            return {
                gap: Object.freeze({
                    lastRevision: this.#revision,
                    oldestAvailableRevision: oldest,
                    requestedFromRevision: requested,
                }),
                kind: "gap",
            };
        }
        const changes = this.#changes.filter(
            (change) => change.revision >= requested,
        );
        return {
            changes: Object.freeze(changes),
            kind: "replay",
            lastRevision: this.#revision,
        };
    }

    onChange(listener: (change: InstanceChange) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
}
