import { spawn } from "node:child_process";

import { createError, errorCodes, type InstanceContainerConfig, type InstanceContainerMountConfig } from "@portable-devshell/shared";

import { WorkerBinary } from "../../WorkerBinary.js";
import { RemoteWorkerInstaller } from "../../install/RemoteWorkerInstaller.js";
import {
    createCommandContext,
    createProviderError,
    waitForCommandResult,
    type ProviderCommandContext,
    type SpawnFunction,
    type WorkerCommandResult,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../WorkerProcess.js";

type ContainerLifecycleStatus = "missing" | "running" | "stopped";

export interface ContainerWorkerTransportBaseOptions {
    binary: string;
    container: InstanceContainerConfig;
    provider: "docker" | "podman";
    remoteCwd?: string;
    spawnFunction?: SpawnFunction;
    workerBinary?: WorkerBinary;
}

export abstract class ContainerWorkerTransportBase implements WorkerCommandTransport {
    readonly #binary: string;
    readonly #container: InstanceContainerConfig;
    readonly #installer: RemoteWorkerInstaller;
    readonly #provider: "docker" | "podman";
    readonly #remoteCwd?: string;
    readonly #spawn: SpawnFunction;
    readonly #workerBinary: WorkerBinary;
    #existingStoppedContainerAdopted = false;

    constructor(options: ContainerWorkerTransportBaseOptions) {
        this.#binary = options.binary;
        this.#container = options.container;
        this.#provider = options.provider;
        this.#remoteCwd = options.remoteCwd;
        this.#spawn = options.spawnFunction ?? spawn;
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#installer = new RemoteWorkerInstaller({
            createContext: (operation, command) => this.#createShellContext(operation, command),
            createProviderError: this.#createProviderError,
            spawnShell: (commandLine, stdio, context) => this.#spawnShell(commandLine, stdio, context)
        });
    }

    async installWorker(): Promise<void> {
        await this.#ensureRuntimeReady("installWorker");
        const installCommand = new WorkerBinary(await this.#resolveExecutable()).buildInstallCommand();
        const invocation = this.#createExecInvocation("installWorker", [installCommand.command, ...installCommand.args]);
        const child = this.#spawnCommand(invocation.context, invocation.args, ["ignore", "pipe", "pipe"]);
        const result = await waitForCommandResult(child, this.#createProviderError, invocation.context);

        if (result.exitCode !== 0) {
            throw this.#createProviderError(invocation.context, new Error(result.stderr || result.stdout || "worker install check failed"), {
                errorCode: errorCodes.coreWorkerProvisionFailed,
                result
            });
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions): Promise<WorkerCommandResult> {
        switch (command) {
            case "start":
                await this.#ensureRuntimeReady("start");
                break;
            case "status":
                return await this.#runStatusCommand(options);
            case "stop":
                return await this.#runStopCommand(options);
            case "logs":
                if (!(await this.#isRuntimeAvailable())) {
                    return this.#syntheticResult("logs", options.instanceName, "");
                }
                break;
        }

        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand(
            command,
            options.instanceName,
            options.extraArgs
        );
        const invocation = this.#createExecInvocation(command, [workerCommand.command, ...workerCommand.args], options.instanceName);
        const child = this.#spawnCommand(invocation.context, invocation.args, ["ignore", "pipe", "pipe"], options.env);
        return await waitForCommandResult(child, this.#createProviderError, invocation.context);
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        await this.#ensureRuntimeReady("spawnWorkerRpc");
        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand("rpc", options.instanceName);
        const invocation = this.#createExecInvocation("spawnWorkerRpc", [workerCommand.command, ...workerCommand.args], options.instanceName);
        return createWorkerRpcProcess(
            this.#spawnCommand(invocation.context, invocation.args, ["pipe", "pipe", "pipe"], options.env, errorCodes.coreWorkerRpcSpawnFailed)
        );
    }

    protected get binary(): string {
        return this.#binary;
    }

    protected get containerConfig(): InstanceContainerConfig {
        return this.#container;
    }

    protected get provider(): "docker" | "podman" {
        return this.#provider;
    }

    protected abstract buildComposeArgs(args: readonly string[]): string[];

    protected abstract buildManagedContainerCreateArgs(image: string, containerName: string): string[];

    async #runStatusCommand(options: WorkerCommandOptions): Promise<WorkerCommandResult> {
        if (!(await this.#isRuntimeAvailable())) {
            return this.#syntheticResult("status", options.instanceName, JSON.stringify({ state: "stopped" }));
        }

        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand("status", options.instanceName, options.extraArgs);
        const invocation = this.#createExecInvocation("status", [workerCommand.command, ...workerCommand.args], options.instanceName);
        const child = this.#spawnCommand(invocation.context, invocation.args, ["ignore", "pipe", "pipe"], options.env);
        return await waitForCommandResult(child, this.#createProviderError, invocation.context);
    }

    async #runStopCommand(options: WorkerCommandOptions): Promise<WorkerCommandResult> {
        if (!(await this.#isRuntimeAvailable())) {
            return this.#syntheticResult("stop", options.instanceName, JSON.stringify({ stopped: true }));
        }

        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand("stop", options.instanceName, options.extraArgs);
        const invocation = this.#createExecInvocation("stop", [workerCommand.command, ...workerCommand.args], options.instanceName);
        const child = this.#spawnCommand(invocation.context, invocation.args, ["ignore", "pipe", "pipe"], options.env);
        const result = await waitForCommandResult(child, this.#createProviderError, invocation.context);

        if (result.exitCode === 0) {
            await this.#afterWorkerStop();
        }

        return result;
    }

    async #resolveExecutable(): Promise<string> {
        return await this.#installer.ensure(this.#workerBinary.executable);
    }

    async #ensureRuntimeReady(operation: string): Promise<void> {
        switch (this.#container.mode) {
            case "preset":
                await this.#ensureManagedContainerReady(this.#container.image, this.#container.containerName);
                return;
            case "dockerfile":
                await this.#ensureDockerfileImage(this.#container.build);
                await this.#ensureManagedContainerReady(
                    this.#container.build.tag ?? `${this.#container.containerName}:latest`,
                    this.#container.containerName
                );
                return;
            case "compose":
                await this.#ensureComposeServiceRunning();
                return;
            case "existingImage":
                await this.#ensureManagedContainerReady(this.#container.image, this.#container.containerName);
                return;
            case "existingStoppedContainer":
                await this.#ensureExistingStoppedContainerReady(operation);
                return;
        }
    }

    async #isRuntimeAvailable(): Promise<boolean> {
        switch (this.#container.mode) {
            case "preset":
            case "dockerfile":
            case "existingImage":
                return (await this.#readContainerStatus(this.#container.containerName)) === "running";
            case "compose":
                return await this.#isComposeServiceRunning();
            case "existingStoppedContainer": {
                const status = await this.#readContainerStatus(this.#container.containerName);
                if (status === "running" && !this.#existingStoppedContainerAdopted) {
                    throw this.#runningContainerUnsupportedError(this.#container.containerName);
                }
                return status === "running";
            }
        }
    }

    async #ensureManagedContainerReady(image: string, containerName: string): Promise<void> {
        const status = await this.#readContainerStatus(containerName);

        if (status === "missing") {
            await this.#createManagedContainer(image, containerName);
            await this.#runProviderCommand("createContainer", ["start", containerName]);
            return;
        }

        if (status !== "running") {
            await this.#runProviderCommand("startContainer", ["start", containerName]);
        }
    }

    async #ensureDockerfileImage(build: Extract<InstanceContainerConfig, { mode: "dockerfile" }>["build"]): Promise<void> {
        const tag = build.tag ?? "devshell-container:latest";
        const result = await this.#runProviderCommand("inspectImage", ["image", "inspect", tag], { allowNonZeroExit: true });

        if (result.exitCode === 0) {
            return;
        }

        const args = ["build", "-t", tag];
        if (build.dockerfile !== undefined) {
            args.push("-f", build.dockerfile);
        }
        args.push(build.context);
        await this.#runProviderCommand("buildImage", args);
    }

    async #ensureComposeServiceRunning(): Promise<void> {
        if (await this.#isComposeServiceRunning()) {
            return;
        }

        const compose = this.#requireComposeConfig();
        await this.#runProviderCommand("composeUp", this.buildComposeArgs(["up", "-d", compose.service]));
    }

    async #isComposeServiceRunning(): Promise<boolean> {
        const compose = this.#requireComposeConfig();
        const result = await this.#runProviderCommand(
            "composePs",
            this.buildComposeArgs(["ps", "-q", compose.service]),
            { allowNonZeroExit: true }
        );

        return result.exitCode === 0 && result.stdout.trim().length > 0;
    }

    async #ensureExistingStoppedContainerReady(operation: string): Promise<void> {
        const containerName = this.#requireExistingStoppedContainer().containerName;
        const status = await this.#readContainerStatus(containerName);

        if (status === "missing") {
            throw this.#missingContainerError(containerName);
        }

        if (status === "running") {
            if (!this.#existingStoppedContainerAdopted) {
                throw this.#runningContainerUnsupportedError(containerName);
            }

            return;
        }

        await this.#runProviderCommand("startContainer", ["start", containerName]);
        this.#existingStoppedContainerAdopted = operation !== "status";
    }

    async #afterWorkerStop(): Promise<void> {
        switch (this.#container.mode) {
            case "preset":
            case "dockerfile":
            case "existingImage":
                await this.#runProviderCommand("stopContainer", ["stop", this.#container.containerName], { allowNonZeroExit: true });
                return;
            case "compose":
                return;
            case "existingStoppedContainer":
                if (this.#container.adoptLifecycle) {
                    await this.#runProviderCommand("stopContainer", ["stop", this.#container.containerName], { allowNonZeroExit: true });
                    this.#existingStoppedContainerAdopted = false;
                }
                return;
        }
    }

    async #createManagedContainer(image: string, containerName: string): Promise<void> {
        await this.#runProviderCommand("createContainer", this.buildManagedContainerCreateArgs(image, containerName));
    }

    async #readContainerStatus(containerName: string): Promise<ContainerLifecycleStatus> {
        const result = await this.#runProviderCommand(
            "inspectContainer",
            ["inspect", "--type", "container", "--format", "{{.State.Status}}", containerName],
            { allowNonZeroExit: true }
        );

        if (result.exitCode !== 0) {
            if (isMissingContainerMessage(result.stderr) || isMissingContainerMessage(result.stdout)) {
                return "missing";
            }

            throw this.#createProviderError(
                this.#createProviderContext("inspectContainer", ["inspect", "--type", "container", "--format", "{{.State.Status}}", containerName]),
                new Error(result.stderr || result.stdout || "container inspect failed"),
                { result }
            );
        }

        const status = result.stdout.trim();
        return status === "running" ? "running" : "stopped";
    }

    async #runProviderCommand(
        operation: string,
        args: readonly string[],
        options: { allowNonZeroExit?: boolean; env?: NodeJS.ProcessEnv } = {}
    ): Promise<WorkerCommandResult> {
        const context = this.#createProviderContext(operation, args);
        const child = this.#spawnCommand(context, args, ["ignore", "pipe", "pipe"], options.env);
        const result = await waitForCommandResult(child, this.#createProviderError, context);

        if (!options.allowNonZeroExit && result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || `${operation} failed`), { result });
        }

        return result;
    }

    #spawnCommand(
        context: ProviderCommandContext,
        args: readonly string[],
        stdio: ["ignore" | "pipe", "pipe", "pipe"],
        env?: NodeJS.ProcessEnv,
        errorCode: string = errorCodes.coreProviderFailed
    ) {
        try {
            return this.#spawn(this.#binary, args, {
                env,
                stdio
            });
        } catch (error) {
            throw this.#createProviderError(context, error, { errorCode });
        }
    }

    #spawnShell(commandLine: string, stdio: ["ignore" | "pipe", "pipe", "pipe"], context: ProviderCommandContext) {
        const args = this.#buildShellExecArgs(commandLine);

        try {
            return this.#spawn(this.#binary, args, { stdio });
        } catch (error) {
            throw this.#createProviderError(context, error);
        }
    }

    #createExecInvocation(operation: string, command: readonly string[], instance?: string) {
        const args = this.#buildExecArgs(command);
        return {
            args,
            context: createCommandContext({
                command: [this.#binary, ...args],
                cwd: this.#remoteCwd,
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
        const args = this.#buildShellExecArgs(command.join(" "));
        return createCommandContext({
            command: [this.#binary, ...args],
            cwd: this.#remoteCwd,
            operation,
            provider: this.#provider
        });
    }

    #buildExecArgs(command: readonly string[]): string[] {
        switch (this.#container.mode) {
            case "compose":
                return this.buildComposeArgs([
                    "exec",
                    "-T",
                    ...this.#workingDirectoryArgs(),
                    this.#container.compose.service,
                    ...command
                ]);
            case "preset":
            case "dockerfile":
            case "existingImage":
                return ["exec", ...this.#workingDirectoryArgs(), "-i", this.#container.containerName, ...command];
            case "existingStoppedContainer":
                return ["exec", ...this.#workingDirectoryArgs(), "-i", this.#container.containerName, ...command];
        }
    }

    #buildShellExecArgs(commandLine: string): string[] {
        switch (this.#container.mode) {
            case "compose":
                return this.buildComposeArgs(["exec", "-T", this.#container.compose.service, "sh", "-lc", commandLine]);
            case "preset":
            case "dockerfile":
            case "existingImage":
                return ["exec", "-i", this.#container.containerName, "sh", "-lc", commandLine];
            case "existingStoppedContainer":
                return ["exec", "-i", this.#container.containerName, "sh", "-lc", commandLine];
        }
    }

    #workingDirectoryArgs(): string[] {
        return this.#remoteCwd ? ["-w", this.#remoteCwd] : [];
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

    #missingContainerError(containerName: string) {
        return createError({
            code: errorCodes.coreProviderFailed,
            details: {
                containerName,
                mode: "existingStoppedContainer",
                provider: this.#provider
            },
            message: `Configured container ${containerName} does not exist.`,
            retryable: false
        });
    }

    #runningContainerUnsupportedError(containerName: string) {
        return createError({
            code: errorCodes.coreProviderFailed,
            details: {
                containerName,
                mode: "existingStoppedContainer",
                provider: this.#provider,
                unsupportedMode: "runningContainer"
            },
            message: `Container ${containerName} is already running. Running container attach is not a supported instance mode.`,
            retryable: false
        });
    }

    readonly #createProviderError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: { exitCode?: number | null; signal?: string; stderr?: string; stdout?: string } }
    ) => createProviderError(context, cause, options);

    #requireComposeConfig(): Extract<InstanceContainerConfig, { mode: "compose" }>["compose"] {
        if (this.#container.mode !== "compose") {
            throw new Error("compose configuration is not available for this container mode");
        }

        return this.#container.compose;
    }

    #requireExistingStoppedContainer(): Extract<InstanceContainerConfig, { mode: "existingStoppedContainer" }> {
        if (this.#container.mode !== "existingStoppedContainer") {
            throw new Error("existing stopped container configuration is not available for this container mode");
        }

        return this.#container;
    }
}

function isMissingContainerMessage(value: string): boolean {
    const normalized = value.toLowerCase();
    return normalized.includes("no such object") || normalized.includes("no such container");
}

export function renderContainerMount(mount: InstanceContainerMountConfig): string {
    const segments = [mount.source, mount.target, mount.mode];

    if (mount.selinux === "shared") {
        segments.push("z");
    } else if (mount.selinux === "private") {
        segments.push("Z");
    }

    return segments.join(":");
}
