import type { WorkerTarget } from "./WorkerTarget.js";

export function workerBinaryFileName(target: WorkerTarget): string {
    return target.os === "windows" ? "devshell-worker.exe" : "devshell-worker";
}

export function workerAssetFileName(target: WorkerTarget): string {
    return target.os === "windows"
        ? `devshell-worker-${target.key}.exe`
        : `devshell-worker-${target.key}`;
}

export function workerInstalledAliasFileName(target: WorkerTarget): string {
    return target.os === "windows"
        ? `devshell-worker-${target.key}.exe`
        : `devshell-worker-${target.key}`;
}
