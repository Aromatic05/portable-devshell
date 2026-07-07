import { rmSync } from "node:fs";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ControlLogger } from "./ControlLogger.js";
import { ControlPidFile } from "./ControlPidFile.js";
import { ControlServer } from "./ControlServer.js";
import { ControlSocketFile } from "./ControlSocketFile.js";

export interface ControlDaemonOptions {
    homeDirectory?: string;
    logger?: ControlLogger;
    pidFile?: ControlPidFile;
    server?: ControlServer;
    socketFile?: ControlSocketFile;
    xdgRuntimeDir?: string;
}

export interface ControlDaemonSpawnOptions {
    daemonModulePath?: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    spawnFunction?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    xdgRuntimeDir?: string;
}

export class ControlDaemon {
    readonly #logger: ControlLogger;
    readonly #pidFile: ControlPidFile;
    readonly #server: ControlServer;
    readonly #socketFile: ControlSocketFile;
    #started = false;

    constructor(options: ControlDaemonOptions = {}) {
        this.#logger = options.logger ?? new ControlLogger(options.homeDirectory);
        this.#pidFile = options.pidFile ?? new ControlPidFile(options.homeDirectory);
        this.#server =
            options.server ??
            new ControlServer({
                homeDirectory: options.homeDirectory,
                xdgRuntimeDir: options.xdgRuntimeDir
            });
        this.#socketFile = options.socketFile ?? new ControlSocketFile(options.xdgRuntimeDir);
    }

    static spawnDetached(options: ControlDaemonSpawnOptions = {}): ChildProcess {
        const spawnFunction = options.spawnFunction ?? spawn;
        const daemonModulePath = options.daemonModulePath ?? fileURLToPath(new URL("./ControlDaemon.js", import.meta.url));
        const nodeBootstrapArgs = collectNodeBootstrapArgs(process.execArgv);
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...options.env
        };

        if (options.homeDirectory !== undefined) {
            env.HOME = options.homeDirectory;
        }

        if (options.xdgRuntimeDir !== undefined) {
            env.XDG_RUNTIME_DIR = options.xdgRuntimeDir;
        }

        const child = spawnFunction(process.execPath, [...nodeBootstrapArgs, daemonModulePath], {
            detached: true,
            env,
            stdio: "ignore"
        });

        child.unref();
        return child;
    }

    async start(): Promise<void> {
        if (this.#started) {
            return;
        }

        await this.#socketFile.ensureRuntimeDir();
        await this.#server.start();
        await this.#pidFile.write();
        await this.#logger.info("control server started");
        this.#started = true;
    }

    async stop(): Promise<void> {
        if (!this.#started) {
            return;
        }

        await this.#logger.info("control server stopping");
        await this.#server.stop();
        await this.#pidFile.remove();
        await this.#socketFile.remove();
        await this.#logger.info("control server stopped");
        this.#started = false;
    }
}

async function main(): Promise<void> {
    const daemon = new ControlDaemon();
    const pidFile = new ControlPidFile();

    process.once("SIGINT", () => {
        void daemon.stop().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
        void daemon.stop().finally(() => process.exit(0));
    });
    process.once("exit", () => {
        rmSync(pidFile.path, { force: true });
    });

    await daemon.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

function collectNodeBootstrapArgs(execArgv: readonly string[]): string[] {
    const args: string[] = [];

    for (let index = 0; index < execArgv.length; index += 1) {
        const current = execArgv[index];

        if ((current === "--import" || current === "--loader") && execArgv[index + 1] !== undefined) {
            args.push(current, execArgv[index + 1]!);
            index += 1;
            continue;
        }

        if (
            current.startsWith("--import=") ||
            current.startsWith("--loader=")
        ) {
            args.push(current);
        }
    }

    return args;
}
