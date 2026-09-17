import type {
    WorkerCommandInteractiveSession,
    WorkerCommandResult,
} from "./Transport.js";
import type { WorkerTransport } from "../Transport.js";

export class WorkerCommandClient {
    readonly #transport: WorkerTransport;
    readonly #instanceName: string;
    readonly #env?: NodeJS.ProcessEnv;

    constructor(
        transport: WorkerTransport,
        instanceName: string,
        env?: NodeJS.ProcessEnv,
    ) {
        this.#transport = transport;
        this.#instanceName = instanceName;
        this.#env = env;
    }

    start(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand(
            "start",
            {
                instanceName: this.#instanceName,
                env: this.#env,
            },
            interactiveSession,
        );
    }

    status(): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("status", {
            instanceName: this.#instanceName,
            env: this.#env,
        });
    }

    stop(): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("stop", {
            instanceName: this.#instanceName,
            env: this.#env,
        });
    }

    logs(): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("logs", {
            instanceName: this.#instanceName,
            env: this.#env,
        });
    }

    retireRuntime(): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("retire", {
            instanceName: this.#instanceName,
            env: this.#env,
        });
    }

    async retireProviderResources(): Promise<void> {
        await this.#transport.retireProviderResources?.();
    }
}
