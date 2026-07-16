import { ControlError, errorCodes, type InstanceContainerConfig } from "@portable-devshell/shared";

import { WorkerBinary } from "../../WorkerBinary.js";
import { WorkerInstallerRemote } from "../../install/WorkerInstallerRemote.js";
import {
    createCommandContext,
    type ProviderCommandContext,
    type SpawnFunction,
    type WorkerCommandResult,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../rpc/WorkerRpcProcess.js";
import {
    createWorkerTargetProbeFailedError,
    parseWorkerTargetProbeOutput,
    workerTargetProbeCommandLine
} from "../../target/WorkerTargetProbe.js";
import {
    createWorkerTransportContainerProvision,
    type WorkerTransportContainerLifecycleStatus,
    type WorkerTransportContainerProvision
} from "../container/WorkerTransportContainerProvision.js";
import { WorkerTransportProcessRunner } from "../process/WorkerTransportProcessRunner.js";

export interface WorkerTransportDriverContainerBaseOptions {
    binary: string;
    container: InstanceContainerConfig;
    keepIdUserNamespace?: boolean;
    provider: "docker" | "podman";
    remoteCwd?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export class WorkerTransportDriverContainerBase implements WorkerCommandTransport {
    readonly #binary: string;
    readonly #installer: WorkerInstallerRemote;
    readonly #process: WorkerTransportProcessRunner;
    readonly #provider: "docker" | "podman";
    readonly #provision: WorkerTransportContainerProvision;
    readonly #remoteCwd?: string;
    readonly #workerBinary: WorkerBinary;

    constructor(options: WorkerTransportDriverContainerBaseOptions) {
        this.#binary = options.binary;
        this.#provider = options.provider;
        this.#remoteCwd = options.remoteCwd;
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#process = new WorkerTransportProcessRunner(options.spawnFunction);
        this.#provision = createWorkerTransportContainerProvision({
            container: options.container,
            keepIdUserNamespace: options.keepIdUserNamespace === true,
            operations: {
                provider: this.#provider,
                readContainerStatus: (containerName) => this.#readContainerStatus(containerName),
                remoteCwd: this.#remoteCwd,
                runProviderCommand: (operation, args, commandOptions) =>
                    this.#runProviderCommand(operation, args, commandOptions)
            }
        });
        this.#installer = new WorkerInstallerRemote({
            createContext: (operation, command) => this.#createShellContext(operation, command),
            createProviderError: this.#process.createError,
            probeTarget: () => this.#probeTarget(),
            spawnShell: (commandLine, stdio, context) => this.#spawnShell(commandLine, stdio, context)
        });
    }

    async installWorker(): Promise<void> {
        await this.#provision.ensureReady("installWorker");
        const installCommand = new WorkerBinary(await this.#resolveExecutable()).buildInstallCommand();
        const invocation = this.#createExecInvocation("installWorker", [installCommand.command, ...installCommand.args]);
        const result = await this.#process.run(invocation.context, {
            stdio: ["ignore", "pipe", "pipe"]
        });

        if (result.exitCode !== 0) {
            throw this.#process.createError(
                invocation.context,
                new Error(result.stderr || result.stdout || "worker install check failed"),
                { errorCode: errorCodes.coreWorkerProvisionFailed, result }
            );
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions): Promise<WorkerCommandResult> {
        switch (command) {
            case "start":
                await this.#provision.ensureReady("start");
                break;
            case "status":
                return await this.#runStatusCommand(options);
            case "stop":
                return await this.#runStopCommand(options);
            case "logs":
                if (!(await this.#provision.isAvailable())) {
                    return this.#syntheticResult("logs", options.instanceName, "");
                }
                break;
        }

        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand(
            command,
            options.instanceName,
            options.extraArgs
        );
        const invocation = this.#createExecInvocation(
            command,
            [workerCommand.command, ...workerCommand.args],
            options.instanceName,
            command === "start"
        );
        return await this.#process.run(invocation.context, {
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"]
        });
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        await this.#provision.ensureReady("spawnWorkerRpc");
        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand("rpc", options.instanceName);
        const invocation = this.#createExecInvocation(
            "spawnWorkerRpc",
            [workerCommand.command, ...workerCommand.args],
            options.instanceName
        );
        return createWorkerRpcProcess(
            this.#process.spawn(
                invocation.context,
                { env: options.env, stdio: ["pipe", "pipe", "pipe"] },
                errorCodes.coreWorkerRpcSpawnFailed
            )
        );
    }

    async #runStatusCommand(options: WorkerCommandOptions): Promise<WorkerCommandResult> {
        if (!(await this.#provision.isAvailable())) {
            return this.#syntheticResult("status", options.instanceName, JSON.stringify({ state: "stopped" }));
        }

        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand(
            "status",
            options.instanceName,
            options.extraArgs
        );
        const invocation = this.#createExecInvocation(
            "status",
            [workerCommand.command, ...workerCommand.args],
            options.instanceName
        );
        return await this.#process.run(invocation.context, {
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"]
        });
    }

    async #runStopCommand(options: WorkerCommandOptions): Promise<WorkerCommandResult> {
        if (!(await this.#provision.isAvailable())) {
            return this.#syntheticResult("stop", options.instanceName, JSON.stringify({ stopped: true }));
        }

        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand(
            "stop",
            options.instanceName,
            options.extraArgs
        );
        const invocation = this.#createExecInvocation(
            "stop",
            [workerCommand.command, ...workerCommand.args],
            options.instanceName
        );
        const result = await this.#process.run(invocation.context, {
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        if (result.exitCode === 0) {
            await this.#provision.afterWorkerStop();
        }

        return result;
    }

    async #resolveExecutable(): Promise<string> {
        return await this.#installer.ensure(this.#workerBinary.executable);
    }

    async #probeTarget() {
        const context = this.#createShellContext("probeTarget", ["sh", "-lc", workerTargetProbeCommandLine]);

        try {
            const result = await this.#process.run(context, { stdio: ["ignore", "pipe", "pipe"] });
            if (result.exitCode !== 0) {
                throw createWorkerTargetProbeFailedError(context, { result });
            }
            return parseWorkerTargetProbeOutput(context, result.stdout);
        } catch (error) {
            if (error instanceof ControlError) {
                throw error;
            }
            throw createWorkerTargetProbeFailedError(context, { cause: error });
        }
    }

    #spawnShell(
        _commandLine: string,
        stdio: ["ignore" | "pipe", "pipe", "pipe"],
        context: ProviderCommandContext
    ) {
        return this.#process.spawn(context, { stdio });
    }

    async #readContainerStatus(containerName: string): Promise<WorkerTransportContainerLifecycleStatus> {
        const args = ["inspect", "--type", "container", "--format", "{{.State.Status}}", containerName];
        const result = await this.#runProviderCommand("inspectContainer", args, { allowNonZeroExit: true });

        if (result.exitCode !== 0) {
            if (isMissingContainerMessage(result.stderr) || isMissingContainerMessage(result.stdout)) {
                return "missing";
            }

            throw this.#process.createError(
                this.#createProviderContext("inspectContainer", args),
                new Error(result.stderr || result.stdout || "container inspect failed"),
                { result }
            );
        }

        return result.stdout.trim() === "running" ? "running" : "stopped";
    }

    async #runProviderCommand(
        operation: string,
        args: readonly string[],
        options: { allowNonZeroExit?: boolean; env?: NodeJS.ProcessEnv } = {}
    ): Promise<WorkerCommandResult> {
        const context = this.#createProviderContext(operation, args);
        const result = await this.#process.run(context, {
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        if (!options.allowNonZeroExit && result.exitCode !== 0) {
            throw this.#process.createError(
                context,
                new Error(result.stderr || result.stdout || `${operation} failed`),
                { result }
            );
        }

        return result;
    }

    #createExecInvocation(
        operation: string,
        command: readonly string[],
        instance?: string,
        useRemoteCwd: boolean = false
    ) {
        const args = this.#provision.buildExecArgs(command, useRemoteCwd);
        return {
            args,
            context: createCommandContext({
                command: [this.#binary, ...args],
                cwd: useRemoteCwd ? this.#remoteCwd : undefined,
                instance,
                operation,
                provider: this.#provider
            })
        };
    }

    #createProviderContext(operation: string, args: readonly string[]): ProviderCommandContext {
        return createCommandContext({
            command: [this.#binary, ...args],
            cwd: this.#remoteCwd,
            operation,
            provider: this.#provider
        });
    }

    #createShellContext(operation: string, command: readonly string[]): ProviderCommandContext {
        const commandLine =
            command[0] === "sh" && command[1] === "-lc" && typeof command[2] === "string"
                ? command[2]
                : command.join(" ");
        const args = this.#provision.buildShellExecArgs(commandLine);
        return createCommandContext({
            command: [this.#binary, ...args],
            cwd: this.#remoteCwd,
            operation,
            provider: this.#provider
        });
    }

    #syntheticResult(operation: string, instance: string, stdout: string): WorkerCommandResult {
        return {
            details: {
                command: [this.#binary],
                commandDisplay: this.#binary,
                cwd: this.#remoteCwd,
                exitCode: 0,
                instance,
                operation,
                provider: this.#provider
            },
            exitCode: 0,
            stderr: "",
            stdout
        };
    }
}

function isMissingContainerMessage(value: string): boolean {
    const normalized = value.toLowerCase();
    return normalized.includes("no such object") || normalized.includes("no such container");
}
