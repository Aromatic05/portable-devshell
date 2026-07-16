import type { WorkerInstance } from "@portable-devshell/core";
import type { InstanceEvent, PrefixRouteStream } from "@portable-devshell/shared";

export interface RuntimeSubscription {
    connectionId: string;
    eventFilter?: (event: InstanceEvent) => boolean;
    instance: Pick<WorkerInstance, "subscribe">;
    instanceName: string;
    nextSeq: number;
    requestId: string;
    stream: PrefixRouteStream;
}
