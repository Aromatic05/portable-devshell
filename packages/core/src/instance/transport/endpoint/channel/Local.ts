import { type ChannelCommandOptions, type CommandOptions, type SpawnFunction } from "./worker/Command.js";
import { createCommandContext } from "./worker/Error.js";
import { ProcessRunner } from "./worker/Process.js";
import { Worker, type WorkerConnection } from "./worker/index.js";

export class LocalConnection implements WorkerConnection {
    #channel = new LocalChannel(this);
    readonly #process: ProcessRunner;

    constructor(options: { spawnFunction?: SpawnFunction } = {}) {
        this.#process = new ProcessRunner(options.spawnFunction);
    }

    get channel(): LocalChannel {
        if (this.#channel.closed) this.#channel = new LocalChannel(this);
        return this.#channel;
    }

    runCommand(operation: string, command: readonly string[], options: CommandOptions = {}) {
        const context = createCommandContext({ command, instance: options.instance, operation, provider: "local" });
        return this.#process.run(context, {
            env: createLocalWorkerEnvironment(options.env),
            input: options.input,
            stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
    }

    async openChannel(operation: string, command: readonly string[], options: ChannelCommandOptions = {}): Promise<LocalChannel> {
        const context = createCommandContext({ command, instance: options.instance, operation, provider: "local" });
        if (this.#channel.connected) this.#channel.close();
        const channel = this.channel;
        channel.attach(this.#process.createChannel(this.#process.spawn(context, {
            env: createLocalWorkerEnvironment(options.env),
            stdio: ["pipe", "pipe", "pipe"],
        }), context));
        return channel;
    }
}

export function createLocalWorkerEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const merged = { ...process.env, ...env };
    delete merged.DEVSHELL_WORKER_INTERNAL_INSTANCE;
    delete merged.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
    delete merged.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
    return merged;
}

export class LocalChannel extends Worker<LocalConnection> {}
