import type {
    ControlInstanceConfig,
    ControlSshInstanceConfig,
    ControlDockerInstanceConfig,
    ControlPodmanInstanceConfig,
} from "@portable-devshell/shared";
import { parseArgsStringToArgv } from "string-argv";

import type { TerminalBackend, TerminalBackendOpenInput } from "./TerminalProcess.js";
import {
    NodePtyTerminalBackend,
    type TerminalLaunchPlan,
} from "./NodePtyTerminalBackend.js";

export interface TerminalBackendFactoryPort {
    create(instance: ControlInstanceConfig): TerminalBackend | undefined;
}

export interface TerminalBackendFactoryOptions {
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}

export class TerminalBackendFactory implements TerminalBackendFactoryPort {
    readonly #environment: NodeJS.ProcessEnv;
    readonly #platform: NodeJS.Platform;

    constructor(options: TerminalBackendFactoryOptions = {}) {
        this.#environment = options.environment ?? process.env;
        this.#platform = options.platform ?? process.platform;
    }

    create(instance: ControlInstanceConfig): TerminalBackend | undefined {
        if (instance.provider === "reverse") return undefined;
        return new NodePtyTerminalBackend({
            resolve: (input) => this.#resolve(instance, input),
        });
    }

    #resolve(
        instance: Exclude<ControlInstanceConfig, { provider: "reverse" }>,
        input: TerminalBackendOpenInput,
    ): TerminalLaunchPlan {
        switch (instance.provider) {
            case "local":
                return this.#local(instance, input);
            case "ssh":
                return this.#ssh(instance, input);
            case "docker":
            case "podman":
                return this.#container(instance, input);
        }
    }

    #local(
        instance: Extract<ControlInstanceConfig, { provider: "local" }>,
        input: TerminalBackendOpenInput,
    ): TerminalLaunchPlan {
        const executable = this.#platform === "win32"
            ? this.#environment.COMSPEC ?? "cmd.exe"
            : this.#environment.SHELL ?? "/bin/sh";
        return {
            args: this.#platform === "win32" ? [] : ["-l"],
            cwd: input.cwd ?? instance.workspace,
            env: { ...this.#environment, ...instance.env },
            executable,
            ...initialCommand(input.command),
        };
    }

    #ssh(
        instance: ControlSshInstanceConfig,
        input: TerminalBackendOpenInput,
    ): TerminalLaunchPlan {
        const command = parseArgsStringToArgv(instance.ssh.command)
            .filter((part) => part.length > 0);
        if (command.length === 0 || command[0] === undefined) {
            throw new Error("ssh.command must not be empty.");
        }
        return {
            args: command.slice(1),
            env: this.#environment,
            executable: command[0],
            ...initialRemoteCommand(input.cwd ?? instance.workspace, input.command),
        };
    }

    #container(
        instance: ControlDockerInstanceConfig | ControlPodmanInstanceConfig,
        input: TerminalBackendOpenInput,
    ): TerminalLaunchPlan {
        const executable = instance.provider === "docker"
            ? instance.dockerBinary ?? "docker"
            : instance.podmanBinary ?? "podman";
        const workspace = input.cwd ?? instance.workspace;
        const args = instance.container.mode === "compose"
            ? composeExecArgs(instance.container.compose, workspace)
            : containerExecArgs(instance.container.containerName, workspace);
        return {
            args,
            env: this.#environment,
            executable,
            ...initialCommand(input.command),
        };
    }
}

function composeExecArgs(
    compose: { file: string; projectName?: string; service: string },
    workspace: string | undefined,
): string[] {
    return [
        "compose",
        "--file",
        compose.file,
        ...(compose.projectName === undefined
            ? []
            : ["--project-name", compose.projectName]),
        "exec",
        ...(workspace === undefined || workspace.length === 0
            ? []
            : ["--workdir", workspace]),
        compose.service,
        "sh",
    ];
}

function containerExecArgs(containerName: string, workspace: string | undefined): string[] {
    return [
        "exec",
        "-it",
        ...(workspace === undefined || workspace.length === 0
            ? []
            : ["--workdir", workspace]),
        containerName,
        "sh",
    ];
}

function initialRemoteCommand(
    cwd: string | undefined,
    command: string | undefined,
): { initialInput?: string } {
    const statements = [
        ...(cwd === undefined || cwd.length === 0 ? [] : [`cd -- ${shellQuote(cwd)}`]),
        ...(command === undefined || command.length === 0 ? [] : [command]),
    ];
    return statements.length === 0
        ? {}
        : { initialInput: `${statements.join("; ")}\r` };
}

function initialCommand(command: string | undefined): { initialInput?: string } {
    return command === undefined || command.length === 0
        ? {}
        : { initialInput: command.endsWith("\r") ? command : `${command}\r` };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
