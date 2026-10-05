import {
    createRemoteError,
    runtimeErrorCodes,
    type CommandResult,
    type RemoteError,
} from "@portable-devshell/shared";

import type { CommandOptions, ProviderCommandContext } from "../../transport/endpoint/channel/worker/Command.js";
import { createCommandContext } from "../../transport/endpoint/channel/worker/Error.js";
import type { WorkerConnection } from "../../transport/endpoint/channel/worker/index.js";

export type WorkerTargetOs = "linux" | "darwin" | "windows";
export type WorkerTargetArch = "x64" | "arm64";
export type WorkerTargetKey =
    | "linux-x64"
    | "linux-arm64"
    | "darwin-x64"
    | "darwin-arm64"
    | "windows-x64"
    | "windows-arm64";

export interface WorkerTarget {
    os: WorkerTargetOs;
    arch: WorkerTargetArch;
    key: WorkerTargetKey;
    rustTarget: string;
}

export const supportedWorkerTargets = Object.freeze<readonly WorkerTarget[]>([
    { os: "linux", arch: "x64", key: "linux-x64", rustTarget: "x86_64-unknown-linux-musl" },
    { os: "linux", arch: "arm64", key: "linux-arm64", rustTarget: "aarch64-unknown-linux-musl" },
    { os: "darwin", arch: "x64", key: "darwin-x64", rustTarget: "x86_64-apple-darwin" },
    { os: "darwin", arch: "arm64", key: "darwin-arm64", rustTarget: "aarch64-apple-darwin" },
    { os: "windows", arch: "x64", key: "windows-x64", rustTarget: "x86_64-pc-windows-msvc" },
    { os: "windows", arch: "arm64", key: "windows-arm64", rustTarget: "aarch64-pc-windows-msvc" },
]);

export const supportedWorkerTargetKeys = Object.freeze(
    supportedWorkerTargets.map((target) => target.key),
);

const workerTargetsByKey = Object.freeze(
    Object.fromEntries(
        supportedWorkerTargets.map((target) => [target.key, target]),
    ) as Record<WorkerTargetKey, WorkerTarget>,
);

export function getWorkerTargetByKey(key: WorkerTargetKey): WorkerTarget {
    return workerTargetsByKey[key];
}

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

export function mapNodeWorkerTarget(input: {
    provider: string;
    operation: string;
    platform: string;
    arch: string;
}): WorkerTarget {
    const rawOs = input.platform.trim();
    const rawArch = input.arch.trim();
    return resolveWorkerTarget({
        provider: input.provider,
        operation: input.operation,
        rawOs,
        rawArch,
        normalizedOs: normalizeNodeOs(rawOs),
        normalizedArch: normalizeNodeArch(rawArch),
    });
}

export function mapUnameWorkerTarget(input: {
    provider: string;
    operation: string;
    rawOs: string;
    rawArch: string;
}): WorkerTarget {
    const rawOs = input.rawOs.trim();
    const rawArch = input.rawArch.trim();
    return resolveWorkerTarget({
        provider: input.provider,
        operation: input.operation,
        rawOs,
        rawArch,
        normalizedOs: normalizeUnameOs(rawOs),
        normalizedArch: normalizeUnameArch(rawArch),
    });
}

export const workerTargetProbeCommandLine = "uname -s && uname -m";

export async function probeRemoteWorkerTarget(
    connection: Pick<WorkerConnection, "runCommand">,
    provider: string,
    options: Pick<CommandOptions, "interactiveSession"> = {},
): Promise<WorkerTarget> {
    const context = createCommandContext({ operation: "probeTarget", command: ["sh", "-lc", workerTargetProbeCommandLine], provider });
    try {
        const result = await connection.runCommand(context.operation, context.command, options);
        if (result.exitCode !== 0) throw createWorkerTargetProbeFailedError(context, { result });
        return parseWorkerTargetProbeOutput(context, result.stdout);
    } catch (error) {
        if (error instanceof Error && "code" in error) throw error;
        throw createWorkerTargetProbeFailedError(context, { cause: error });
    }
}

export function probeLocalWorkerTarget(
    provider = "local",
    operation = "resolveExecutable",
    platform = process.platform,
    arch = process.arch,
): WorkerTarget {
    return mapNodeWorkerTarget({ provider, operation, platform, arch });
}

export function parseWorkerTargetProbeOutput(
    context: ProviderCommandContext,
    stdout: string,
): WorkerTarget {
    const normalizedOutput = stdout.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const [rawOs = "", rawArch = ""] = normalizedOutput.split("\n");
    return mapUnameWorkerTarget({
        provider: context.provider,
        operation: context.operation,
        rawArch,
        rawOs,
    });
}

export function createWorkerTargetProbeFailedError(
    context: ProviderCommandContext,
    input: { cause?: unknown; result?: Partial<CommandResult> } = {},
): RemoteError {
    return createRemoteError({
        code: runtimeErrorCodes.workerTargetProbeFailed,
        cause: input.cause,
        details: {
            commandDisplay: input.result?.details?.commandDisplay ?? context.commandDisplay,
            ...(typeof input.result?.exitCode === "number" || input.result?.exitCode === null
                ? { exitCode: input.result.exitCode }
                : {}),
            operation: context.operation,
            provider: context.provider,
            ...(typeof input.result?.stderr === "string" && input.result.stderr.length > 0
                ? { stderrTail: tail(input.result.stderr) }
                : {}),
            ...(typeof input.result?.stdout === "string" && input.result.stdout.length > 0
                ? { stdoutTail: tail(input.result.stdout) }
                : {}),
        },
        message: `Worker target probe failed for provider ${context.provider}.`,
        retryable: false,
    });
}

export function createWorkerTargetUnsupportedError(input: {
    provider: string;
    operation: string;
    rawOs: string;
    rawArch: string;
    normalizedOs?: WorkerTargetOs;
    normalizedArch?: WorkerTargetArch;
}): RemoteError {
    return createRemoteError({
        code: runtimeErrorCodes.workerTargetUnsupported,
        details: {
            operation: input.operation,
            provider: input.provider,
            rawArch: input.rawArch,
            rawOs: input.rawOs,
            ...(input.normalizedArch === undefined ? {} : { normalizedArch: input.normalizedArch }),
            ...(input.normalizedOs === undefined ? {} : { normalizedOs: input.normalizedOs }),
            supportedTargets: Array.from(supportedWorkerTargetKeys),
        },
        message: `Worker target is unsupported for provider ${input.provider}.`,
        retryable: false,
    });
}

function resolveWorkerTarget(input: {
    provider: string;
    operation: string;
    rawOs: string;
    rawArch: string;
    normalizedOs?: WorkerTargetOs;
    normalizedArch?: WorkerTargetArch;
}): WorkerTarget {
    if (input.normalizedOs === undefined || input.normalizedArch === undefined)
        throw createWorkerTargetUnsupportedError(input);
    const key = `${input.normalizedOs}-${input.normalizedArch}` as WorkerTargetKey;
    const target = workerTargetsByKey[key];
    if (target === undefined) throw createWorkerTargetUnsupportedError(input);
    return target;
}

function normalizeNodeOs(rawOs: string): WorkerTargetOs | undefined {
    switch (rawOs) {
        case "linux": return "linux";
        case "darwin": return "darwin";
        case "win32": return "windows";
        default: return undefined;
    }
}

function normalizeNodeArch(rawArch: string): WorkerTargetArch | undefined {
    switch (rawArch) {
        case "x64": return "x64";
        case "arm64": return "arm64";
        default: return undefined;
    }
}

function normalizeUnameOs(rawOs: string): WorkerTargetOs | undefined {
    switch (rawOs.toLowerCase()) {
        case "linux": return "linux";
        case "darwin": return "darwin";
        default: return undefined;
    }
}

function normalizeUnameArch(rawArch: string): WorkerTargetArch | undefined {
    switch (rawArch.toLowerCase()) {
        case "x86_64":
        case "amd64":
            return "x64";
        case "aarch64":
        case "arm64":
            return "arm64";
        default:
            return undefined;
    }
}

const COMMAND_OUTPUT_TAIL_LIMIT = 4000;
function tail(value: string): string {
    return value.length <= COMMAND_OUTPUT_TAIL_LIMIT
        ? value
        : value.slice(-COMMAND_OUTPUT_TAIL_LIMIT);
}
