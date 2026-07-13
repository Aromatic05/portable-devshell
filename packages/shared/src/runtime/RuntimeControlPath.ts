import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeDirectoryName = "portable-devshell";

export function resolveControlRuntimeDirectory(
    xdgRuntimeDir = process.env.XDG_RUNTIME_DIR,
): string {
    if (xdgRuntimeDir !== undefined && xdgRuntimeDir.length > 0) {
        return join(xdgRuntimeDir, runtimeDirectoryName);
    }

    return join(tmpdir(), `${runtimeDirectoryName}-${resolveUserIdentity()}`);
}

export function resolveControlSocketPath(
    xdgRuntimeDir = process.env.XDG_RUNTIME_DIR,
): string {
    return join(resolveControlRuntimeDirectory(xdgRuntimeDir), "control.sock");
}

function resolveUserIdentity(): string {
    if (typeof process.getuid === "function") {
        return String(process.getuid());
    }

    const name = process.env.USER ?? process.env.USERNAME ?? "user";
    const normalized = name.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
    return normalized.length === 0 ? "user" : normalized;
}
