import { sep } from "node:path";

/**
 * @compat control-daemon-entrypoint
 * @removeAt 1.0.0
 */
const CONTROL_DAEMON_RELATIVE_PATHS = [
    "node_modules/@portable-devshell/control/dist/server/Daemon.js",
    "node_modules/@portable-devshell/control/dist/server/ControlDaemon.js",
];

export function assertRunningControlMatchesApplication({
    applicationDirectory,
    commandLine,
    controlRunning,
    pid,
}) {
    if (!controlRunning) return;
    if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        typeof commandLine !== "string" ||
        commandLine.trim().length === 0
    ) {
        throw new Error(
            "Cannot verify the running Control process identity; installation is cancelled before shutdown.",
        );
    }
    const root = normalizePath(applicationDirectory);
    const command = normalizePath(commandLine);
    if (
        !CONTROL_DAEMON_RELATIVE_PATHS.some((relativePath) =>
            command.includes(`${root}/${relativePath}`),
        )
    ) {
        throw new Error(
            `The running Control PID ${pid} does not belong to the activated application generation; installation is cancelled before shutdown.`,
        );
    }
}

export function isPortableDevshellControlCommand(commandLine) {
    if (typeof commandLine !== "string" || commandLine.trim().length === 0)
        return false;
    const command = normalizePath(commandLine);
    return CONTROL_DAEMON_RELATIVE_PATHS.some((relativePath) =>
        command.includes(`/${relativePath}`),
    );
}

function normalizePath(value) {
    return String(value)
        .replaceAll("\\", "/")
        .replaceAll(sep, "/")
        .replace(/\/+$/u, "");
}
