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
        if (this.#started) return;
        await this.#socketFile.ensureRuntimeDir();
        await this.#server.start();
        await this.#pidFile.write();
        await this.#logger.info("control server started");
        this.#started = true;
    }

    async stop(): Promise<void> {
        if (!this.#started) return;
        await this.#logger.info("control server stopping");
        await this.#server.stop();
        await this.#logger.info("control server stopped");
        this.#started = false;
    }
}

export function controlDaemonModulePath(): string {
    return fileURLToPath(new URL("./ControlDaemon.js", import.meta.url));
}

async function main(): Promise<void> {
    const daemon = new ControlDaemon();
    process.once("SIGINT", () => void daemon.stop().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void daemon.stop().finally(() => process.exit(0)));
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
