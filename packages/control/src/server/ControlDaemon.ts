import { fileURLToPath } from "node:url";

import {
    ControlLogger,
    ControlPidFile,
    ControlSocketFile
} from "@portable-devshell/shared";

import { ControlServer } from "./ControlServer.js";

export interface ControlDaemonOptions {
    homeDirectory?: string;
    logger?: ControlLogger;
    pidFile?: ControlPidFile;
    server?: ControlServer;
    socketFile?: ControlSocketFile;
    xdgRuntimeDir?: string;
}

export class ControlDaemon {
    readonly #logger: ControlLogger;
    readonly #pidFile: ControlPidFile;
    readonly #server: ControlServer;
    readonly #socketFile: ControlSocketFile;
    #operationTail: Promise<void> = Promise.resolve();
    #started = false;

    constructor(options: ControlDaemonOptions = {}) {
        this.#logger = options.logger ?? new ControlLogger(options.homeDirectory);
        this.#pidFile = options.pidFile ?? new ControlPidFile(options.homeDirectory);
        this.#server = options.server ?? new ControlServer({
            homeDirectory: options.homeDirectory,
            xdgRuntimeDir: options.xdgRuntimeDir
        });
        this.#socketFile = options.socketFile ?? new ControlSocketFile(options.xdgRuntimeDir);
    }

    async start(): Promise<void> {
        await this.#runExclusive(async () => await this.#start());
    }

    async #start(): Promise<void> {
        if (this.#started) return;
        await this.#socketFile.ensureRuntimeDir();
        await this.#server.start();
        this.#started = true;
        try {
            await this.#pidFile.write();
            await this.#logger.info("control server started");
        } catch (error) {
            await this.#server.stop().catch(() => undefined);
            this.#started = false;
            throw error;
        }
    }

    async stop(): Promise<void> {
        await this.#runExclusive(async () => await this.#stop());
    }

    async #stop(): Promise<void> {
        if (!this.#started) return;
        const failures: unknown[] = [];
        await this.#logger.info("control server stopping").catch((error) => failures.push(error));
        try {
            await this.#server.stop();
            this.#started = false;
        } catch (error) {
            failures.push(error);
        }
        await this.#logger.info("control server stopped").catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(failures, "Control server failed to stop cleanly.");
        }
    }

    async #runExclusive<T>(factory: () => Promise<T>): Promise<T> {
        const operation = this.#operationTail.then(factory, factory);
        this.#operationTail = operation.then(
            () => undefined,
            () => undefined
        );
        return await operation;
    }
}

export function controlDaemonModulePath(): string {
    return fileURLToPath(new URL("./ControlDaemon.js", import.meta.url));
}

async function main(): Promise<void> {
    const daemon = new ControlDaemon();
    const stopAndExit = () => {
        void daemon.stop().then(
            () => process.exit(0),
            (error) => {
                console.error(error);
                process.exit(1);
            }
        );
    };
    process.once("SIGINT", stopAndExit);
    process.once("SIGTERM", stopAndExit);
    await daemon.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main().catch((error) => {
        return new ControlLogger()
            .error(renderStartupFailure(error))
            .catch(() => undefined)
            .finally(() => {
                console.error(error);
                process.exit(1);
            });
    });
}

function renderStartupFailure(error: unknown): string {
    if (error instanceof Error && typeof error.stack === "string" && error.stack.length > 0) {
        return `control server failed to start\n${error.stack}`;
    }
    return `control server failed to start\n${String(error)}`;
}
