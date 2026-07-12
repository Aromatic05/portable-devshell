import type { WorkerInstance } from "@portable-devshell/core";
import type { InstanceEvent } from "@portable-devshell/shared";

import type { ControlRpcConnection } from "../../control/rpc/ControlRpcConnection.js";

export interface StreamSubscriptionInstance {
    connection: ControlRpcConnection;
    connectionId: string;
    instance: WorkerInstance;
    eventFilter?: (event: InstanceEvent) => boolean;
    instanceName: string;
    nextSeq: number;
}
