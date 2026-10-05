import type { WorkerRuntime } from "../Command.js";
import { runWorkerCommand, type WorkerChannelOptions, type WorkerCommandName, type WorkerCommandOptions, type WorkerCommandResult } from "../Command.js";
import { WorkerBinary } from "../../Binary.js";
import { ContainerInstall } from "../../provision/install/provider/Container.js";

export class ContainerExecution implements WorkerRuntime {
    readonly #install: ContainerInstall;

    constructor(install: ContainerInstall) {
        this.#install = install;
    }

    async connectChannel(options: WorkerChannelOptions) {
        await this.#install.ensureReady("connectChannel");
        const built = new WorkerBinary(
            await this.#install.resolveExecutable(),
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

    async retireProviderResources(): Promise<void> {
        await this.#install.retireProviderResources();
    }

    async runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
    ): Promise<WorkerCommandResult> {
        let preparedRuntimeRetire = false;

        switch (command) {
            case "start":
                await this.#install.ensureReady("start");
                break;
            case "status":
                if (!(await this.#install.isAvailable()))
                    return this.#syntheticResult(
                        "status",
                        options.instanceName,
                        JSON.stringify({ state: "stopped" }),
                    );
                break;
            case "stop":
                if (!(await this.#install.isAvailable()))
                    return this.#syntheticResult(
                        "stop",
                        options.instanceName,
                        JSON.stringify({ stopped: true }),
                    );
                break;
            case "logs":
                if (!(await this.#install.isAvailable()))
                    return this.#syntheticResult(
                        "logs",
                        options.instanceName,
                        "",
                    );
                break;
            case "retire":
                preparedRuntimeRetire =
                    await this.#install.prepareRuntimeRetire();
                if (!preparedRuntimeRetire)
                    return this.#syntheticResult(
                        "retire",
                        options.instanceName,
                        JSON.stringify({ retired: false }),
                    );
                break;
        }

        try {
            const executable = await this.#install.resolveExecutable();
            const result = await runWorkerCommand(this.#install.connection, executable, command, options);
            if (command === "stop" && result.exitCode === 0)
                await this.#install.afterWorkerStop();
            return result;
        } finally {
            if (preparedRuntimeRetire)
                await this.#install.finishRuntimeRetire();
        }
    }

    #syntheticResult(
        operation: string,
        instance: string,
        stdout: string,
    ): WorkerCommandResult {
        return {
            details: {
                command: [this.#install.binary],
                commandDisplay: this.#install.binary,
                exitCode: 0,
                instance,
                operation,
                provider: this.#install.provider,
            },
            exitCode: 0,
            stderr: "",
            stdout,
        };
    }
}
