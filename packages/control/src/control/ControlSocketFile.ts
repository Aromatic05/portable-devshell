import { ControlPathRuntime } from "./path/ControlPathRuntime.js";
import { ControlSocketFileUnix } from "./platform/ControlSocketFileUnix.js";
import { ControlSocketFileWindows } from "./platform/ControlSocketFileWindows.js";

interface ControlSocketFilePlatform {
    ensureRuntimeDir(runtimeDir: string): Promise<void>;
    remove(path: string): Promise<void>;
}

export class ControlSocketFile {
    readonly runtimeDir: string;
    readonly path: string;
    readonly #platform: ControlSocketFilePlatform;

    constructor(
        xdgRuntimeDir: string | undefined = undefined,
        platform = process.platform,
        environment: NodeJS.ProcessEnv = process.env
    ) {
        const runtimePath = new ControlPathRuntime(xdgRuntimeDir, platform, environment);
        this.runtimeDir = runtimePath.runtimeDir;
        this.path = runtimePath.socketFile;
        this.#platform = platform === "win32" ? new ControlSocketFileWindows() : new ControlSocketFileUnix();
    }

    async ensureRuntimeDir(): Promise<void> {
        await this.#platform.ensureRuntimeDir(this.runtimeDir);
    }

    async remove(): Promise<void> {
        await this.#platform.remove(this.path);
    }
}