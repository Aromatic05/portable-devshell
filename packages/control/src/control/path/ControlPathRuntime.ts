import { join } from "node:path";

export class ControlPathRuntime {
    readonly runtimeDir: string;
    readonly socketFile: string;

    constructor(xdgRuntimeDir = process.env.XDG_RUNTIME_DIR) {
        if (xdgRuntimeDir === undefined || xdgRuntimeDir.length === 0) {
            throw new Error("XDG_RUNTIME_DIR must be set.");
        }

        this.runtimeDir = join(xdgRuntimeDir, "portable-devshell");
        this.socketFile = join(this.runtimeDir, "control.sock");
    }
}
