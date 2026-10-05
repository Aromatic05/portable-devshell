import type { WorkerRuntime } from "../Command.js";
import type { WorkerCommandInteractiveSession } from "../../../transport/endpoint/channel/worker/Command.js";
import { runWorkerCommand, type WorkerChannelOptions, type WorkerCommandName, type WorkerCommandOptions } from "../Command.js";
import { WorkerBinary } from "../../Binary.js";
import { SshInstall, type SshInstallOptions } from "../../provision/install/provider/Ssh.js";

export interface SshExecutionOptions extends SshInstallOptions { install?: SshInstall; }

export class SshExecution implements WorkerRuntime {
    readonly #install: SshInstall;
    constructor(options: SshExecutionOptions) { this.#install = options.install ?? new SshInstall(options); }

    installWorker(interactiveSession?: WorkerCommandInteractiveSession): Promise<void> { return this.#install.installWorker(interactiveSession); }

    async connectChannel(options: WorkerChannelOptions) {
        const built = new WorkerBinary(
            await this.#install.resolveExecutable(options.interactiveSession),
        ).buildCommand("transport", options.instanceName);
        return await this.#install.connection.openChannel(
            "connectChannel",
            [built.command, ...built.args],
            { env: options.env, instance: options.instanceName, interactiveSession: options.interactiveSession },
        );
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions, interactiveSession?: WorkerCommandInteractiveSession) {
        const executable = await this.#install.resolveExecutable(interactiveSession);
        return await runWorkerCommand(this.#install.connection, executable, command, options, interactiveSession);
    }
}
