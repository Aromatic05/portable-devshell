import {
    resolveUnixControlRuntimeDirectory,
    resolveUnixControlSocketPath
} from "./RuntimeControlPathUnix.js";
import {
    resolveWindowsControlPipePath,
    resolveWindowsControlRuntimeDirectory
} from "./RuntimeControlPathWindows.js";

export function resolveControlRuntimeDirectory(
    xdgRuntimeDir: string | undefined = undefined,
    platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env
): string {
    return platform === "win32"
        ? resolveWindowsControlRuntimeDirectory(xdgRuntimeDir, environment)
        : resolveUnixControlRuntimeDirectory(xdgRuntimeDir ?? environment.XDG_RUNTIME_DIR, environment);
}

export function resolveControlSocketPath(
    xdgRuntimeDir: string | undefined = undefined,
    platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env
): string {
    return platform === "win32"
        ? resolveWindowsControlPipePath(environment)
        : resolveUnixControlSocketPath(xdgRuntimeDir ?? environment.XDG_RUNTIME_DIR, environment);
}

export function isWindowsNamedPipePath(path: string): boolean {
    return path.startsWith("\\\\.\\pipe\\");
}