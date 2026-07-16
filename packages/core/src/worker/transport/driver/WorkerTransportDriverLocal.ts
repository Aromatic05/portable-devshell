import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

import { ControlError, errorCodes } from "@portable-devshell/shared";

import { WorkerAssetResolver } from "../../WorkerAssetResolver.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import {
    createCommandContext,
    type SpawnFunction,
    type ProviderCommandContext,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../rpc/WorkerRpcProcess.js";
import { WorkerInstallerLocal, type WorkerInstallerLocalResult } from "../../install/WorkerInstallerLocal.js";
import { resolveWorkerDevshellHomeDirectory } from "../../platform/WorkerHomeDirectory.js";
import { workerInstalledAliasFileName } from "../../target/WorkerTargetBinary.js";
import { probeLocalWorkerTarget } from "../../target/WorkerTargetProbe.js";
import { WorkerTransportProcessRunner } from "../process/WorkerTransportProcessRunner.js";

export interface WorkerTransportDriverLocalOptions {
    installer?: WorkerInstallerLocal;
    resolver?: WorkerAssetResolver;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class WorkerTransportDriverLocal implements WorkerCommandTransport {
    readonly #installer: WorkerInstallerLocal;
    readonly #resolver: WorkerAssetResolver;
    readonly #workerBinary: WorkerBinary;
    readonly #process: WorkerTransportProcessRunner;

    constructor(options: WorkerTransportDriverLocalOptions = {}) {
        this.#installer = options.installer ?? new WorkerInstallerLocal();
        this.#resolver = options.resolver ?? new WorkerAssetResolver();
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#process = new WorkerTransportProcessRunner(options.spawnFunction);
    }

    async installWorker(): Promise<void> {
        const installCommand = new WorkerBinary(await this.#resolveExecutable()).buildInstallCommand();
        const context = this.#createCommandContext("installWorker", [installCommand.command, ...installCommand.args]);
        const result = await this.#process.run(context, {
            env: this.#mergeEnv(undefined),
            stdio: ["ignore", "pipe", "pipe"]
        });
        if (result.exitCode !== 0) {
            throw this.#process.createError(context, new Error(result.stderr || result.stdout || "worker install check failed"), {
                errorCode: errorCodes.coreWorkerProvisionFailed,
                result
            });
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions) {
        if (command === "start" && this.#workerBinary.executable === "devshell-worker") {
            const installed = await this.#provisionExecutable(options.env);
            const statusResult = await this.#runResolvedCommand(installed.executablePath, "status", {
                instanceName: options.instanceName,
                env: options.env
            });
            const daemon = readDaemonIdentity(statusResult.exitCode, statusResult.stdout);
            if (!daemon.known || (daemon.running && daemon.workerSha256 !== installed.sha256)) {
                const stopResult = await this.#runResolvedCommand(installed.executablePath, "stop", {
                    instanceName: options.instanceName,
                    env: options.env
                });
                if (stopResult.exitCode !== 0) {
                    throw this.#process.createError(
                        this.#createCommandContext("upgradeWorker", [installed.executablePath, "stop", "--instance", options.instanceName], {
                            instance: options.instanceName
                        }),
                        new Error(stopResult.stderr || stopResult.stdout || "existing worker could not be stopped"),
                        { errorCode: errorCodes.coreWorkerProvisionFailed, result: stopResult }
                    );
                }
            }
            return await this.#runResolvedCommand(installed.executablePath, command, options);
        }

        return await this.#runResolvedCommand(await this.#resolveActiveExecutable(options.env), command, options);
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const workerCommand = new WorkerBinary(await this.#resolveActiveExecutable(options.env)).buildCommand("rpc", options.instanceName);
        const context = this.#createCommandContext("spawnWorkerRpc", [workerCommand.command, ...workerCommand.args], {
            instance: options.instanceName
        });
        const child = this.#process.spawn(
            context,
            {
                env: this.#mergeEnv(options.env),
                stdio: ["pipe", "pipe", "pipe"]
            },
            errorCodes.coreWorkerRpcSpawnFailed
        );
        return createWorkerRpcProcess(child);
    }

    async #resolveExecutable(env?: NodeJS.ProcessEnv): Promise<string> {
        return (await this.#provisionExecutable(env)).executablePath;
    }

    async #resolveActiveExecutable(env?: NodeJS.ProcessEnv): Promise<string> {
        if (this.#workerBinary.executable !== "devshell-worker") {
            return this.#workerBinary.executable;
        }

        const environment = this.#mergeEnv(env);
        const devshellHomeDirectory = resolveWorkerDevshellHomeDirectory(environment);
        const target = probeLocalWorkerTarget("local", "resolveExecutable");
        const activeExecutable =
            target.os === "windows"
                ? resolve(devshellHomeDirectory, "bin", workerInstalledAliasFileName(target))
                : resolve(devshellHomeDirectory, "bin", "devshell-worker");
        if (isReadableFile(activeExecutable)) {
            return activeExecutable;
        }
        return (await this.#provisionExecutable(env)).executablePath;
    }

    async #provisionExecutable(env?: NodeJS.ProcessEnv): Promise<WorkerInstallerLocalResult> {
        if (this.#workerBinary.executable !== "devshell-worker") {
            return { executablePath: this.#workerBinary.executable, sha256: "" };
        }

        const environment = this.#mergeEnv(env);
        const devshellHomeDirectory = resolveWorkerDevshellHomeDirectory(environment);

        const target = probeLocalWorkerTarget("local", "resolveExecutable");
        const asset = await this.#resolver.resolve(target, environment).catch((error) => {
            if (error instanceof ControlError) {
                throw error;
            }

            throw this.#process.createError(this.#createCommandContext("resolveExecutable", ["devshell-worker"]), error);
        });

        return await this.#installer.ensureInstalled(devshellHomeDirectory, asset, target).catch((error) => {
            throw this.#process.createError(this.#createCommandContext("resolveExecutable", ["devshell-worker"]), error, {
                errorCode: errorCodes.coreWorkerProvisionFailed
            });
        });
    }

    async #runResolvedCommand(
        executable: string,
        command: WorkerCommandName,
        options: WorkerCommandOptions
    ): Promise<Awaited<ReturnType<WorkerCommandTransport["runWorkerCommand"]>>> {
        const workerCommand = new WorkerBinary(executable).buildCommand(command, options.instanceName, options.extraArgs);
        const context = this.#createCommandContext(command, [workerCommand.command, ...workerCommand.args], {
            cwd: command === "start" ? options.workspacePath : undefined,
            instance: options.instanceName
        });
        return await this.#process.run(context, {
            cwd: context.cwd,
            env: this.#mergeEnv(options.env),
            stdio: ["ignore", "pipe", "pipe"]
        });
    }

    #mergeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
        const merged = {
            ...process.env,
            ...env
        };
        delete merged.DEVSHELL_WORKER_INTERNAL_INSTANCE;
        delete merged.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
        delete merged.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
        return merged;
    }

    #createCommandContext(
        operation: string,
        command: readonly string[],
        options: { cwd?: string; instance?: string } = {}
    ): ProviderCommandContext {
        return createCommandContext({
            command,
            cwd: options.cwd,
            instance: options.instance,
            operation,
            provider: "local"
        });
    }

}

function isReadableFile(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}


function readDaemonIdentity(
    exitCode: number | null,
    stdout: string
): { known: boolean; running: boolean; workerSha256?: string } {
    if (exitCode !== 0) {
        return { known: false, running: false };
    }
    try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        if (parsed.state !== "running" && parsed.state !== "stale" && parsed.state !== "stopped") {
            return { known: false, running: false };
        }
        return {
            known: true,
            running: parsed.state === "running",
            workerSha256: typeof parsed.workerSha256 === "string" ? parsed.workerSha256 : undefined
        };
    } catch {
        return { known: false, running: false };
    }
}
