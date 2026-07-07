import { mkdir, rm } from "node:fs/promises";

import { ControlPathRuntime } from "./path/ControlPathRuntime.js";

export class ControlSocketFile {
    readonly runtimeDir: string;
    readonly path: string;

    constructor(xdgRuntimeDir?: string) {
        const runtimePath = new ControlPathRuntime(xdgRuntimeDir);
        this.runtimeDir = runtimePath.runtimeDir;
        this.path = runtimePath.socketFile;
    }

    async ensureRuntimeDir(): Promise<void> {
        await mkdir(this.runtimeDir, { recursive: true });
    }

    async remove(): Promise<void> {
        await rm(this.path, { force: true });
    }
}
