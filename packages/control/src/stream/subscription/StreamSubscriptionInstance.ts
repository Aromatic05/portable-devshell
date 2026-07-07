import type { WorkerInstance } from "@portable-devshell/core";

import type { ControlRpcConnection } from "../../control/rpc/ControlRpcConnection.js";

export interface StreamSubscriptionInstance {
    connection: ControlRpcConnection;
    connectionId: string;
    instance: WorkerInstance;
    instanceName: string;
    nextSeq: number;
}
