import { createRemoteError, runtimeErrorCodes, type InstanceContainerConfig } from "@portable-devshell/shared";
import { type ChannelCommandOptions, type CommandOptions, type SpawnFunction } from "./Command.js";
import { createCommandContext } from "./Error.js";
import { ProcessRunner } from "./Process.js";
import { Worker, type WorkerConnection } from "./index.js";

export interface ContainerConnectionOptions {
    binary: string;
    provider: "docker" | "podman";
    container: InstanceContainerConfig;
    spawnFunction?: SpawnFunction;
}

export class ContainerConnection implements WorkerConnection {
    readonly binary: string;
    readonly provider: "docker" | "podman";
    #channel: Worker<ContainerConnection>;
    readonly #container: InstanceContainerConfig;
    readonly #process: ProcessRunner;

    constructor(options: ContainerConnectionOptions) {
        this.binary = options.binary;
        this.provider = options.provider;
        this.#container = options.container;
        this.#process = new ProcessRunner(options.spawnFunction);
        this.#channel = this.createChannel();
    }

    get channel(): Worker<ContainerConnection> {
        if (this.#channel.closed) this.#channel = this.createChannel();
        return this.#channel;
    }

    async runProviderCommand(operation: string, args: readonly string[], options: { allowNonZeroExit?: boolean; env?: NodeJS.ProcessEnv } = {}) {
        const context = createCommandContext({ command: [this.binary, ...args], operation, provider: this.provider });
        const result = await this.#process.run(context, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
        if (!options.allowNonZeroExit && result.exitCode !== 0) throw this.#process.createError(context, new Error(result.stderr || result.stdout || operation + " failed"), { result });
        return result;
    }

    async readContainerStatus(containerName: string): Promise<"missing" | "running" | "stopped"> {
        const args = ["inspect", "--type", "container", "--format", "{{.State.Status}}", containerName];
        const result = await this.runProviderCommand("inspectContainer", args, { allowNonZeroExit: true });
        if (result.exitCode !== 0) {
            if (isMissingContainerMessage(result.stderr) || isMissingContainerMessage(result.stdout)) return "missing";
            const context = createCommandContext({ command: [this.binary, ...args], operation: "inspectContainer", provider: this.provider });
            throw this.#process.createError(context, new Error(result.stderr || result.stdout || "container inspect failed"), { result });
        }
        return result.stdout.trim() === "running" ? "running" : "stopped";
    }

    #buildExecArgs(command: readonly string[], environmentKeys: readonly string[] = []): string[] {
        const environmentArgs = environmentKeys.flatMap(key => ["-e", key]);
        const container = this.#container;
        if (container.mode === "compose") {
            return ["compose", "-f", container.compose.file, ...(container.compose.projectName === undefined ? [] : ["-p", container.compose.projectName]), "exec", "-T", ...environmentArgs, container.compose.service, ...command];
        }
        return ["exec", "-i", ...environmentArgs, container.containerName, ...command];
    }

    runCommand(
        operation: string,
        command: readonly string[],
        options: CommandOptions = {},
    ) {
        const environment = createContainerWorkerEnvironment({ env: options.env, platform: process.platform, processEnvironment: process.env, provider: this.provider });
        const context = createCommandContext({ command: [this.binary, ...this.#buildExecArgs(command, environment.keys)], instance: options.instance, operation, provider: this.provider });
        return this.#process.run(context, {
            env: environment.processEnv,
            input: options.input,
            stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
    }

    async openChannel(operation: string, command: readonly string[], options: ChannelCommandOptions = {}): Promise<Worker<ContainerConnection>> {
        const environment = createContainerWorkerEnvironment({ env: options.env, platform: process.platform, processEnvironment: process.env, provider: this.provider });
        const context = createCommandContext({ command: [this.binary, ...this.#buildExecArgs(command, environment.keys)], instance: options.instance, operation, provider: this.provider });
        if (this.#channel.connected) this.#channel.close();
        const channel = this.channel;
        channel.attach(this.#process.createChannel(this.#process.spawn(context, { env: environment.processEnv, stdio: ["pipe", "pipe", "pipe"] }), context));
        return channel;
    }

    protected createChannel(): Worker<ContainerConnection> {
        return new Worker(this);
    }
}

const providerEnvironmentKeys = new Set([
    "CONTAINERS_CONF",
    "CONTAINERS_STORAGE_CONF",
    "CONTAINER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_HOST",
    "HOME",
    "PATH",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
]);

export function createContainerWorkerEnvironment(options: {
    env: NodeJS.ProcessEnv | undefined;
    platform: NodeJS.Platform;
    processEnvironment: NodeJS.ProcessEnv;
    provider: "docker" | "podman";
}): { keys: string[]; processEnv?: NodeJS.ProcessEnv } {
    if (options.env === undefined) {
        return { keys: [] };
    }

    const conflicts = [
        ...new Set(
            Object.keys(options.env)
                .filter((key) => options.env?.[key] !== undefined)
                .map((key) =>
                    canonicalProviderEnvironmentKey(key, options.platform),
                )
                .filter((key): key is string => key !== undefined),
        ),
    ].sort();
    if (conflicts.length > 0) {
        throw createRemoteError({
            code: runtimeErrorCodes.providerFailed,
            details: {
                environmentKeys: conflicts,
                provider: options.provider,
            },
            message: `Container instance environment cannot override provider-reserved variables: ${conflicts.join(", ")}.`,
            retryable: false,
        });
    }

    const processEnv = normalizeProviderProcessEnvironment(
        options.processEnvironment,
        options.platform,
    );
    const keys: string[] = [];
    for (const [key, value] of Object.entries(options.env)) {
        if (value === undefined || isInternalWorkerEnvironmentKey(key)) {
            continue;
        }
        processEnv[key] = value;
        keys.push(key);
    }
    keys.sort();
    return { keys, processEnv };
}

function canonicalProviderEnvironmentKey(
    key: string,
    platform: NodeJS.Platform,
): string | undefined {
    if (platform === "win32") {
        const normalized = key.toUpperCase();
        return providerEnvironmentKeys.has(normalized) ? normalized : undefined;
    }
    return providerEnvironmentKeys.has(key) ? key : undefined;
}

function normalizeProviderProcessEnvironment(
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
    const normalized = { ...environment };
    if (platform !== "win32") {
        return normalized;
    }

    for (const canonical of providerEnvironmentKeys) {
        const matches = Object.keys(normalized).filter(
            (key) => key.toUpperCase() === canonical,
        );
        if (matches.length === 0) {
            continue;
        }
        const selected = matches.includes(canonical) ? canonical : matches[0];
        const value = selected === undefined ? undefined : normalized[selected];
        for (const key of matches) {
            delete normalized[key];
        }
        if (value !== undefined) {
            normalized[canonical] = value;
        }
    }
    return normalized;
}

function isInternalWorkerEnvironmentKey(key: string): boolean {
    return (
        key === "DEVSHELL_WORKER_INTERNAL_INSTANCE" ||
        key === "DEVSHELL_WORKER_INTERNAL_WORKSPACE" ||
        key === "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE"
    );
}

function isMissingContainerMessage(value: string): boolean {
    const normalized = value.toLowerCase();
    return (
        normalized.includes("no such object") ||
        normalized.includes("no such container")
    );
}
