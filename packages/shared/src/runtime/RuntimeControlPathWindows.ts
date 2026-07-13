import { tmpdir } from "node:os";
import { win32 } from "node:path";

const runtimeDirectoryName = "portable-devshell";
const pipePrefix = "\\\\.\\pipe\\portable-devshell-control-";

export function resolveWindowsControlRuntimeDirectory(
    explicitRuntimeDir: string | undefined,
    environment: NodeJS.ProcessEnv
): string {
    const base =
        explicitRuntimeDir ??
        environment.LOCALAPPDATA ??
        environment.TEMP ??
        environment.TMP ??
        tmpdir();
    return win32.join(base, runtimeDirectoryName, "runtime");
}

export function resolveWindowsControlPipePath(environment: NodeJS.ProcessEnv): string {
    return `${pipePrefix}${resolveWindowsUserIdentity(environment)}`;
}

function resolveWindowsUserIdentity(environment: NodeJS.ProcessEnv): string {
    const raw = environment.USERNAME ?? environment.USER ?? "user";
    const normalized = raw.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
    return normalized.length === 0 ? "user" : normalized;
}
