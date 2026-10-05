import { runtimeErrorCodes } from "@portable-devshell/shared";
import { WorkerBinary } from "../../../Binary.js";
import { SshConnection, type SshConnectionOptions } from "../../../../transport/endpoint/channel/Ssh.js";
import type { WorkerCommandInteractiveSession } from "../../../../Api.js";
import { WorkerInstallerRemote } from "../Remote.js";
import { createCommandContext, createProviderError } from "../../../../transport/endpoint/channel/worker/Error.js";

export interface SshInstallOptions extends SshConnectionOptions {
    workerBinary?: WorkerBinary;
    connection?: SshConnection;
}

export class SshInstall {
    readonly connection: SshConnection;
    readonly workerBinary: WorkerBinary;
    readonly #installer: WorkerInstallerRemote;

    constructor(options: SshInstallOptions) {
        this.connection = options.connection ?? new SshConnection(options);
        this.workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#installer = new WorkerInstallerRemote({ connection: this.connection, provider: "ssh" });
    }

    async resolveExecutable(interactiveSession?: WorkerCommandInteractiveSession): Promise<string> {
        return await this.#installer.ensure(this.workerBinary.executable, interactiveSession);
    }

    async installWorker(interactiveSession?: WorkerCommandInteractiveSession): Promise<void> {
        const built = new WorkerBinary(await this.resolveExecutable(interactiveSession)).buildInstallCommand();
        const context = createCommandContext({ operation: "installWorker", command: [built.command, ...built.args], provider: "ssh" });
        const result = await this.connection.runCommand(context.operation, context.command, { interactiveSession });
        if (result.exitCode !== 0) throw createProviderError(context, new Error(result.stderr || result.stdout || "worker install check failed"), { errorCode: runtimeErrorCodes.workerProvisionFailed, result });
    }

}
