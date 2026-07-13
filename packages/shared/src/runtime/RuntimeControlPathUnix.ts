import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeDirectoryName = "portable-devshell";

export function resolveUnixControlRuntimeDirectory(
    xdgRuntimeDir: string | undefined,
    environment: NodeJS.ProcessEnv
): string {
    if (xdgRuntimeDir !== undefined && xdgRuntimeDir.length > 0) {
        return join(xdgRuntimeDir, runtimeDirectoryName);
    }

    return join(tmpdir(), `${runtimeDirectoryName}-${resolveUnixUserIdentity(environment)}`);
}

export function resolveUnixControlSocketPath(
    xdgRuntimeDir: string | undefined,
    environment: NodeJS.ProcessEnv
): string {
    return join(resolveUnixControlRuntimeDirectory(xdgRuntimeDir, environment), "control.sock");
}

function resolveUnixUserIdentity(environment: NodeJS.ProcessEnv): string {
    if (typeof process.getuid === "function") {
        return String(process.getuid());
    }

    return normalizeIdentity(environment.USER ?? environment.USERNAME ?? "user");
}

function normalizeIdentity(value: string): string {
    const normalized = value.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
    return normalized.length === 0 ? "user" : normalized;
}
