import {
    resolveControlRuntimeDirectory,
    resolveControlSocketPath,
} from "../../runtime/RuntimeControlPath.js";

export class ControlPathRuntime {
    readonly runtimeDir: string;
    readonly socketFile: string;

    constructor(
        xdgRuntimeDir: string | undefined = undefined,
        platform = process.platform,
        environment: NodeJS.ProcessEnv = process.env
    ) {
        this.runtimeDir = resolveControlRuntimeDirectory(xdgRuntimeDir, platform, environment);
        this.socketFile = resolveControlSocketPath(xdgRuntimeDir, platform, environment);
    }
}
