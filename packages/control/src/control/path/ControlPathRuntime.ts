import {
    resolveControlRuntimeDirectory,
    resolveControlSocketPath,
} from "@portable-devshell/shared";

export class ControlPathRuntime {
    readonly runtimeDir: string;
    readonly socketFile: string;

    constructor(xdgRuntimeDir = process.env.XDG_RUNTIME_DIR) {
        this.runtimeDir = resolveControlRuntimeDirectory(xdgRuntimeDir);
        this.socketFile = resolveControlSocketPath(xdgRuntimeDir);
    }
}
