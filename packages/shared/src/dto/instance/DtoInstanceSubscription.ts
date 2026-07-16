import type { InstanceEvent } from "./DtoInstanceEvent.js";

export interface InstanceSubscription {
    events: InstanceEvent[];
    lastSeq: number;
}
