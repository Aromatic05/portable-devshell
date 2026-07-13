import { parseArgsStringToArgv } from "string-argv";
import { isAttachShellSupported } from "./AttachShellAvailability.js";

import {
    AttachShellResolutionError,
    type AttachShellCommand,
    type AttachShellProvider,
    type AttachShellResolutionInput
} from "./AttachShellTypes.js";

export class AttachShellCommandResolver {
    resolve(input: AttachShellResolutionInput): AttachShellCommand {
        const configured = readInstanceConfig(input.configView, input.instance.name);
        const provider = readProvider(configured, input.instance.provider);

        if (provider !== "reverse" && !isAttachShellSupported(provider)) {
            throw new AttachShellResolutionError(
                `Attach Shell is not supported for ${provider} instances on Windows.`
            );
        }

        switch (provider) {
            case "local":
                return this.#local(input);
            case "ssh":
                return this.#ssh(configured);
            case "docker":
            case "podman":
                return this.#container(provider, configured, input);
            case "reverse":
                throw new AttachShellResolutionError(
                    "Reverse instances are self-managed and do not support direct Attach Shell."
                );
        }
    }

    #local(input: AttachShellResolutionInput): AttachShellCommand {
        const shell = input.environment?.SHELL;
        return {
            args: ["-l"],
            command: shell === undefined || shell.length === 0 ? "bash" : shell,
            cwd: input.instance.defaultWorkspace,
            fallbackCommands: shell === undefined || shell.length === 0 ? [{ args: ["-l"], command: "sh" }] : [{ args: ["-l"], command: "bash" }, { args: ["-l"], command: "sh" }]
        };
    }

    #ssh(configured: Record<string, unknown> | undefined): AttachShellCommand {
        const ssh = asRecord(configured?.ssh);
        const value = typeof ssh?.command === "string" ? ssh.command.trim() : "";
        const argv = parseArgsStringToArgv(value).filter((part) => part.length > 0);

        if (argv.length === 0) {
            throw new AttachShellResolutionError("Attach Shell requires configured ssh.command.");
        }

        return { args: argv.slice(1), command: argv[0] };
    }

    #container(
        provider: "docker" | "podman",
        configured: Record<string, unknown> | undefined,
        input: AttachShellResolutionInput
    ): AttachShellCommand {
        if (input.snapshot?.daemonState !== "running") {
            throw new AttachShellResolutionError("Container is not running. Use Start Worker first.");
        }

        const binaryKey = provider === "docker" ? "dockerBinary" : "podmanBinary";
        const configuredBinary = configured?.[binaryKey];
        const binary = typeof configuredBinary === "string" ? configuredBinary : provider;
        const container = asRecord(configured?.container);

        if (container?.mode === "compose") {
            const compose = asRecord(container.compose);
            const service = typeof compose?.service === "string" ? compose.service : undefined;
            if (compose === undefined || service === undefined) {
                throw new AttachShellResolutionError("Attach Shell requires configured compose service.");
            }

            const prefix = composePrefix(binary, compose);
            return withShellFallback(prefix, service, {
                args: [...prefix.slice(1, -1), "ps", "--status", "running", "--services"],
                command: binary,
                expectedOutput: service
            });
        }

        const name = typeof container?.containerName === "string" ? container.containerName : undefined;
        if (name === undefined) {
            throw new AttachShellResolutionError("Attach Shell requires configured container identity.");
        }

        return withShellFallback([binary, "exec", "-it"], name, {
            args: ["inspect", "--format", "{{.State.Running}}", name],
            command: binary,
            expectedOutput: "true"
        });
    }
}

function readInstanceConfig(configView: AttachShellResolutionInput["configView"], name: string): Record<string, unknown> | undefined {
    if (!Array.isArray(configView?.instances)) {
        return undefined;
    }

    return configView.instances.find((entry) => asRecord(entry)?.name === name) as Record<string, unknown> | undefined;
}

function readProvider(configured: Record<string, unknown> | undefined, fallback: string | undefined): AttachShellProvider {
    const value = typeof configured?.provider === "string" ? configured.provider : fallback;
    if (value === "local" || value === "ssh" || value === "docker" || value === "podman" || value === "reverse") {
        return value;
    }

    throw new AttachShellResolutionError("Attach Shell requires provider information from control.");
}

function composePrefix(binary: string, compose: Record<string, unknown>): string[] {
    const file = typeof compose.file === "string" ? compose.file : undefined;
    const projectName = typeof compose.projectName === "string" ? compose.projectName : undefined;
    if (file === undefined) {
        throw new AttachShellResolutionError("Attach Shell requires configured compose project/service.");
    }

    return [binary, "compose", "--file", file, ...(projectName === undefined ? [] : ["--project-name", projectName]), "exec"];
}

function withShellFallback(prefix: string[], target: string, readinessCheck: AttachShellCommand["readinessCheck"]): AttachShellCommand {
    return {
        args: [...prefix.slice(1), target, "bash"],
        command: prefix[0] ?? "",
        fallbackCommands: [{ args: [...prefix.slice(1), target, "sh"], command: prefix[0] ?? "" }],
        fallbackOnExitCode: 127,
        readinessCheck
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
