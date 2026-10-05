import { runtimeErrorCodes } from "@portable-devshell/shared";
import { WorkerBinary } from "../../../Binary.js";
import { ContainerConnection, type ContainerConnectionOptions } from "../../../../transport/endpoint/channel/worker/Container.js";
import { WorkerInstallerRemote } from "../Remote.js";
import { createCommandContext, createProviderError } from "../../../../transport/endpoint/channel/worker/Error.js";
import { createContainerProvision, type ContainerProvision } from "../../container/Provision.js";

export interface ContainerInstallOptions extends ContainerConnectionOptions {
    keepIdUserNamespace?: boolean;
    workerBinary?: WorkerBinary;
    connection?: ContainerConnection;
}

export class ContainerInstall {
    readonly connection: ContainerConnection;
    readonly workerBinary: WorkerBinary;
    readonly #installer: WorkerInstallerRemote;
    readonly #provision: ContainerProvision;

    constructor(options: ContainerInstallOptions) {
        this.connection = options.connection ?? new ContainerConnection(options);
        this.workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#provision = createContainerProvision({ container: options.container, keepIdUserNamespace: options.keepIdUserNamespace === true, operations: this.connection });
        this.#installer = new WorkerInstallerRemote({ connection: this.connection, provider: this.connection.provider });
    }

    get binary(): string { return this.connection.binary; }
    get provider(): "docker" | "podman" { return this.connection.provider; }
    ensureReady(operation: string): Promise<void> { return this.#provision.ensureReady(operation); }
    isAvailable(): Promise<boolean> { return this.#provision.isAvailable(); }
    prepareRuntimeRetire(): Promise<boolean> { return this.#provision.prepareRuntimeRetire(); }
    finishRuntimeRetire(): Promise<void> { return this.#provision.finishRuntimeRetire(); }
    afterWorkerStop(): Promise<void> { return this.#provision.afterWorkerStop(); }
    retireProviderResources(): Promise<void> { return this.#provision.retire(); }
    resolveExecutable(): Promise<string> { return this.#installer.ensure(this.workerBinary.executable); }

    async installWorker(): Promise<void> {
        await this.#provision.ensureReady("installWorker");
        const built = new WorkerBinary(await this.resolveExecutable()).buildInstallCommand();
        const context = createCommandContext({ operation: "installWorker", command: [built.command, ...built.args], provider: this.connection.provider });
        const result = await this.connection.runCommand(context.operation, context.command);
        if (result.exitCode !== 0) throw createProviderError(context, new Error(result.stderr || result.stdout || "worker install check failed"), { errorCode: runtimeErrorCodes.workerProvisionFailed, result });
    }

}
