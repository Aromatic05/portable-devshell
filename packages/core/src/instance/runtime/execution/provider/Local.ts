import type { WorkerRuntime } from "../Command.js";
import { runWorkerCommand, type WorkerChannelOptions, type WorkerCommandName, type WorkerCommandOptions } from "../Command.js";
import { WorkerBinary } from "../../Binary.js";
import { type SpawnFunction } from "../../../transport/endpoint/channel/worker/Command.js";
import { createCommandContext, createProviderError } from "../../../transport/endpoint/channel/worker/Error.js";
import {
    LocalInstall,
    type LocalInstallOptions,
} from "../../provision/install/provider/Local.js";
import { parseWorkerStatus } from "../../supervision/Status.js";

export interface LocalExecutionOptions extends LocalInstallOptions {
    install?: LocalInstall;
    spawnFunction?: SpawnFunction;
}

export class LocalExecution implements WorkerRuntime {
    readonly #install: LocalInstall;

    constructor(options: LocalExecutionOptions = {}) {
        this.#install = options.install ?? new LocalInstall(options);
    }

    async connectChannel(options: WorkerChannelOptions) {
        const built = new WorkerBinary(
            await this.#install.resolveActiveExecutable(options.env),
        ).buildCommand("transport", options.instanceName);
        return await this.#install.connection.openChannel(
            "connectChannel",
            [built.command, ...built.args],
            { env: options.env, instance: options.instanceName, interactiveSession: options.interactiveSession },
        );
    }

    async installWorker(): Promise<void> {
        await this.#install.installWorker();
    }

    async runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
    ) {
        if (
            command === "retire" &&
            this.#install.workerBinary.executable === "devshell-worker"
        ) {
            const installed = await this.#install.provisionExecutable(options.env);
            return await runWorkerCommand(
                this.#install.connection,
                installed.executablePath,
                command,
                options,
            );
        }

        if (
            command === "start" &&
            this.#install.workerBinary.executable === "devshell-worker"
        ) {
            const installed = await this.#install.provisionExecutable(options.env);
            const status = await runWorkerCommand(
                this.#install.connection,
                installed.executablePath,
                "status",
                { instanceName: options.instanceName, env: options.env },
            );
            const daemon = readDaemonIdentity(
                status.exitCode,
                status.stdout,
                options.instanceName,
            );
            if (
                !daemon.known ||
                (daemon.running && daemon.workerSha256 !== installed.sha256)
            ) {
                const stopped = await runWorkerCommand(
                    this.#install.connection,
                    installed.executablePath,
                    "stop",
                    { instanceName: options.instanceName, env: options.env },
                );
                if (stopped.exitCode !== 0) {
                    throw createProviderError(
                        createCommandContext({
                            command: [
                                installed.executablePath,
                                "stop",
                                "--instance",
                                options.instanceName,
                            ],
                            instance: options.instanceName,
                            operation: "upgradeWorker",
                            provider: "local",
                        }),
                        new Error(
                            stopped.stderr ||
                                stopped.stdout ||
                                "existing worker could not be stopped",
                        ),
                        { result: stopped },
                    );
                }
            }
            return await runWorkerCommand(
                this.#install.connection,
                installed.executablePath,
                command,
                options,
            );
        }

        return await runWorkerCommand(
            this.#install.connection,
            await this.#install.resolveActiveExecutable(options.env),
            command,
            options,
        );
    }
}

function readDaemonIdentity(
    exitCode: number | null,
    stdout: string,
    instanceName: string,
): { known: boolean; running: boolean; workerSha256?: string } {
    if (exitCode !== 0) return { known: false, running: false };
    try {
        const status = parseWorkerStatus(stdout, instanceName);
        return {
            known: true,
            running: status.daemonState === "running",
            workerSha256: status.workerSha256,
        };
    } catch {
        return { known: false, running: false };
    }
}
