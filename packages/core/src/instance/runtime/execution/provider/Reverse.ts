import {
    createRemoteError,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type { WorkerInstanceConnection } from "../../supervision/Connection.js";
import type {
    InstanceSnapshot,
    InstanceStateUpdate,
} from "../../supervision/State.js";

export class ReverseExecution {
    readonly #name: string;
    readonly #connection: WorkerInstanceConnection;
    readonly #applyStateUpdate: (
        update: InstanceStateUpdate,
    ) => Promise<InstanceSnapshot>;

    constructor(options: {
        name: string;
        connection: WorkerInstanceConnection;
        applyStateUpdate(
            update: InstanceStateUpdate,
        ): Promise<InstanceSnapshot>;
    }) {
        this.#name = options.name;
        this.#connection = options.connection;
        this.#applyStateUpdate = options.applyStateUpdate;
    }

    start(): never {
        throw this.#lifecycleError("start");
    }

    stop(): never {
        throw this.#lifecycleError("stop");
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        if (!this.#connection.connected) {
            this.#connection.markReverseOffline();
            this.#connection.clearHandshake();
            return await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "unknown",
                lastErrorCode: undefined,
                lastErrorMessage: undefined,
                pid: undefined,
            });
        }
        return await this.#connection.refreshRunningStatus(undefined);
    }

    #lifecycleError(operation: "start" | "stop") {
        return createRemoteError({
            code: runtimeErrorCodes.reverseSelfManagedLifecycle,
            details: { instance: this.#name, operation },
            message: `Instance ${this.#name} is self-managed; ${operation} it on the remote machine.`,
            retryable: false,
        });
    }
}
