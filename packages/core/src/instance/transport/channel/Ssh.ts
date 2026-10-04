import type { ChildProcess } from "node:child_process";

import type { Channel } from "@portable-devshell/shared";

import { WorkerBinary } from "../../runtime/Binary.js";
import type { ChannelOptions } from "../../runtime/process/Model.js";
import type { ProviderCommandContext } from "../../runtime/process/index.js";

export interface SshTransportOptions {
    cleanupEnvironment(environmentFile: string | undefined): Promise<void>;
    createChannel(child: ChildProcess, context: ProviderCommandContext): Channel;
    createContext(
        operation: string,
        commandLine: string,
        options?: { instance?: string },
    ): ProviderCommandContext;
    prepareEnvironment(env: NodeJS.ProcessEnv | undefined): Promise<string | undefined>;
    resolveExecutable(): Promise<string>;
    spawn(
        commandLine: string,
        stdio: ["pipe", "pipe", "pipe"],
        context: ProviderCommandContext,
    ): ChildProcess;
    withEnvironment(commandLine: string, environmentFile: string | undefined): string;
}

export class SshTransport {
    readonly #options: SshTransportOptions;

    constructor(options: SshTransportOptions) {
        this.#options = options;
    }

    async connectChannel(options: ChannelOptions) {
        const executable = await this.#options.resolveExecutable();
        const workerCommand = new WorkerBinary(executable).buildCommand(
            "transport",
            options.instanceName,
        );
        const commandLine = [workerCommand.command, ...workerCommand.args]
            .map(shellEscape)
            .join(" ");
        const environmentFile = await this.#options.prepareEnvironment(
            options.env,
        );
        const remoteCommandLine = this.#options.withEnvironment(
            commandLine,
            environmentFile,
        );
        const context = this.#options.createContext(
            "connectChannel",
            remoteCommandLine,
            { instance: options.instanceName },
        );
        let child: ChildProcess;
        try {
            child = this.#options.spawn(
                remoteCommandLine,
                ["pipe", "pipe", "pipe"],
                context,
            );
        } catch (error) {
            await this.#options.cleanupEnvironment(environmentFile).catch(
                () => undefined,
            );
            throw error;
        }
        child.once("exit", () => {
            void this.#options.cleanupEnvironment(environmentFile).catch(
                () => undefined,
            );
        });
        return this.#options.createChannel(child, context);
    }
}

function shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
