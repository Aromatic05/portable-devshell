import { createError, errorCodes, type ControlError } from "@portable-devshell/shared";

import {
    supportedWorkerTargetKeys,
    supportedWorkerTargets,
    type WorkerTarget,
    type WorkerTargetArch,
    type WorkerTargetKey,
    type WorkerTargetOs
} from "./WorkerTarget.js";

const workerTargetsByKey = Object.freeze(
    Object.fromEntries(supportedWorkerTargets.map((target) => [target.key, target])) as Record<WorkerTargetKey, WorkerTarget>
);

export function getWorkerTargetByKey(key: WorkerTargetKey): WorkerTarget {
    return workerTargetsByKey[key];
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
        normalizedArch: normalizeNodeArch(rawArch)
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
        normalizedArch: normalizeUnameArch(rawArch)
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
    if (input.normalizedOs === undefined || input.normalizedArch === undefined) {
        throw createWorkerTargetUnsupportedError(input);
    }

    const key = `${input.normalizedOs}-${input.normalizedArch}` as WorkerTargetKey;
    const target = workerTargetsByKey[key];

    if (target === undefined) {
        throw createWorkerTargetUnsupportedError(input);
    }

    return target;
}

export function createWorkerTargetUnsupportedError(input: {
    provider: string;
    operation: string;
    rawOs: string;
    rawArch: string;
    normalizedOs?: WorkerTargetOs;
    normalizedArch?: WorkerTargetArch;
}): ControlError {
    return createError({
        code: errorCodes.coreWorkerTargetUnsupported,
        details: {
            operation: input.operation,
            provider: input.provider,
            rawArch: input.rawArch,
            rawOs: input.rawOs,
            ...(input.normalizedArch === undefined ? {} : { normalizedArch: input.normalizedArch }),
            ...(input.normalizedOs === undefined ? {} : { normalizedOs: input.normalizedOs }),
            supportedTargets: Array.from(supportedWorkerTargetKeys)
        },
        message: `Worker target is unsupported for provider ${input.provider}.`,
        retryable: false
    });
}

function normalizeNodeOs(rawOs: string): WorkerTargetOs | undefined {
    switch (rawOs) {
        case "linux":
            return "linux";
        case "darwin":
            return "darwin";
        default:
            return undefined;
    }
}

function normalizeNodeArch(rawArch: string): WorkerTargetArch | undefined {
    switch (rawArch) {
        case "x64":
            return "x64";
        case "arm64":
            return "arm64";
        default:
            return undefined;
    }
}

function normalizeUnameOs(rawOs: string): WorkerTargetOs | undefined {
    switch (rawOs.toLowerCase()) {
        case "linux":
            return "linux";
        case "darwin":
            return "darwin";
        default:
            return undefined;
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
