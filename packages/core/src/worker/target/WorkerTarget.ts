export type WorkerTargetOs = "linux" | "darwin";
export type WorkerTargetArch = "x64" | "arm64";
export type WorkerTargetKey = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

export interface WorkerTarget {
    os: WorkerTargetOs;
    arch: WorkerTargetArch;
    key: WorkerTargetKey;
    rustTarget: string;
}

export const supportedWorkerTargets = Object.freeze<readonly WorkerTarget[]>([
    {
        os: "linux",
        arch: "x64",
        key: "linux-x64",
        rustTarget: "x86_64-unknown-linux-musl"
    },
    {
        os: "linux",
        arch: "arm64",
        key: "linux-arm64",
        rustTarget: "aarch64-unknown-linux-musl"
    },
    {
        os: "darwin",
        arch: "x64",
        key: "darwin-x64",
        rustTarget: "x86_64-apple-darwin"
    },
    {
        os: "darwin",
        arch: "arm64",
        key: "darwin-arm64",
        rustTarget: "aarch64-apple-darwin"
    }
]);

export const supportedWorkerTargetKeys = Object.freeze(supportedWorkerTargets.map((target) => target.key));
