import { sep } from "node:path";

export function assertRunningControlMatchesApplication({
    applicationDirectory,
    commandLine,
    controlRunning,
    pid,
}) {
    if (!controlRunning) return;
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof commandLine !== "string" || commandLine.trim().length === 0) {
        throw new Error("Cannot verify the running Control process identity; installation is cancelled before shutdown.");
    }
    if (!commandLine.includes("ControlDaemon.js")) {
        throw new Error(`Cannot verify running Control PID ${pid}: ControlDaemon.js is not present in its command line.`);
    }
    const root = normalizePath(applicationDirectory);
    const command = normalizePath(commandLine);
    if (!command.includes(`${root}/`)) {
        throw new Error(
            `The running Control PID ${pid} does not belong to the activated application generation; installation is cancelled before shutdown.`
        );
    }
}

function normalizePath(value) {
    return String(value)
        .replaceAll("\\", "/")
        .replaceAll(sep, "/")
        .replace(/\/+$/u, "");
}
