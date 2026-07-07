import type { WorkerCommandTransport, WorkerCommandResult } from "../provider/command/WorkerCommandTransport.js";

export class WorkerCommandClient {
    readonly #transport: WorkerCommandTransport;
    readonly #instanceName: string;
    readonly #env?: NodeJS.ProcessEnv;

    constructor(transport: WorkerCommandTransport, instanceName: string, env?: NodeJS.ProcessEnv) {
        this.#transport = transport;
        this.#instanceName = instanceName;
        this.#env = env;
    }

    start(workspacePath: string): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("start", {
            instanceName: this.#instanceName,
            workspacePath,
            env: this.#env
        });
    }

    status(): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("status", {
            instanceName: this.#instanceName,
            env: this.#env
        });
    }

    stop(): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("stop", {
            instanceName: this.#instanceName,
            env: this.#env
        });
    }

    logs(): Promise<WorkerCommandResult> {
        return this.#transport.runWorkerCommand("logs", {
            instanceName: this.#instanceName,
            env: this.#env
        });
    }
}
