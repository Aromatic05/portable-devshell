// Thin InstanceEvent specialization of the generic connect/retry/backoff
// engine. Domain recovery policy stays in the owning ViewModel via onGap.

import {
    EventSubscription,
    type SubscriptionStatus,
} from "../../transport/stream/Subscription.js";
import {
    readInstanceStreamGap,
    type InstanceEventStreamPort,
    type InstanceStreamGap,
} from "./Contract.js";
import type { InstanceEvent } from "./Model.js";

export type InstanceEventSubscriptionStatus = SubscriptionStatus;

export interface InstanceEventSubscriptionOptions {
    onEvent(event: InstanceEvent): void;
    /**
     * Recover from a gap and return the sequence to resume from. Return
     * undefined to let the subscription retry with backoff.
     */
    onGap(
        gap: InstanceStreamGap,
    ): Promise<number | undefined> | number | undefined;
    onStatusChange?(status: InstanceEventSubscriptionStatus): void;
    open(fromSeq: number): Promise<InstanceEventStreamPort>;
    retryBaseMs?: number;
    retryMaxMs?: number;
}

export class InstanceEventSubscription extends EventSubscription<InstanceEvent> {
    constructor(fromSeq: number, options: InstanceEventSubscriptionOptions) {
        super(fromSeq, {
            ...options,
            eventSeq: (event) => event.seq,
            readGapError: readInstanceStreamGap,
        });
    }
}
