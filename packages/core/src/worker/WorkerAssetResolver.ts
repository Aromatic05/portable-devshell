import { accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createError, errorCodes } from "@portable-devshell/shared";

import type { WorkerTarget } from "./target/WorkerTarget.js";
import { supportedWorkerTargetKeys } from "./target/WorkerTarget.js";
import { probeLocalWorkerTarget } from "./target/WorkerTargetProbe.js";

export interface WorkerAsset {
    target: WorkerTarget;
    binaryPath: string;
    sha256: string;
    source: "env" | "package" | "dev";
    searchedPaths: string[];
}

const bundledWorkerRelativePath = "../../assets/workers";
const legacyBundledWorkerRelativePath = "../../assets/devshell-worker";

export class WorkerAssetResolver {
    readonly #moduleDir: string;

    constructor(moduleUrl: string = import.meta.url) {
        this.#moduleDir = dirname(fileURLToPath(moduleUrl));
    }

    async resolve(target: WorkerTarget): Promise<WorkerAsset> {
        const searchedPaths: string[] = [];

        for (const candidate of this.#candidatePaths(target)) {
            const binaryPath = candidate.binaryPath;
            searchedPaths.push(binaryPath);

            if (!isReadableFile(binaryPath)) {
                continue;
            }

            return {
                target,
                binaryPath,
                searchedPaths: [...searchedPaths],
                sha256: createHash("sha256").update(await readFile(binaryPath)).digest("hex"),
                source: candidate.source
            };
        }

        throw createError({
            code: errorCodes.coreWorkerAssetUnavailable,
            details: {
                envVarNames: this.#supportedEnvVarNames(target),
                searchedPaths,
                supportedTargets: Array.from(supportedWorkerTargetKeys),
                targetArch: target.arch,
                targetKey: target.key,
                targetOs: target.os
            },
            message: `Worker asset is unavailable for target ${target.key}.`,
            retryable: false
        });
    }

    *#candidatePaths(target: WorkerTarget): Iterable<{ binaryPath: string; source: WorkerAsset["source"] }> {
        const hostTarget = probeLocalWorkerTarget("local", "resolveExecutable");
        const hostTargetMatches = hostTarget.key === target.key;
        const targetEnvVarName = toTargetEnvVarName(target);
        const targetEnvPath = process.env[targetEnvVarName];

        if (targetEnvPath !== undefined && targetEnvPath.length > 0) {
            yield {
                binaryPath: targetEnvPath,
                source: "env"
            };
        }

        yield {
            binaryPath: resolve(this.#moduleDir, bundledWorkerRelativePath, target.key, "devshell-worker"),
            source: "package"
        };

        if (!hostTargetMatches) {
            return;
        }

        const legacyEnvPath = process.env.PORTABLE_DEVSHELL_WORKER_PATH;
        if (legacyEnvPath !== undefined && legacyEnvPath.length > 0) {
            yield {
                binaryPath: legacyEnvPath,
                source: "env"
            };
        }

        if (target.os !== "linux") {
            yield {
                binaryPath: resolve(this.#moduleDir, legacyBundledWorkerRelativePath),
                source: "dev"
            };
        }

        let probeDir = this.#moduleDir;
        for (let depth = 0; depth < 6; depth += 1) {
            yield {
                binaryPath: resolve(probeDir, "target", target.rustTarget, "debug", "devshell-worker"),
                source: "dev"
            };
            yield {
                binaryPath: resolve(probeDir, "target", target.rustTarget, "release", "devshell-worker"),
                source: "dev"
            };
            if (target.os !== "linux") {
                yield {
                    binaryPath: resolve(probeDir, "target/debug/devshell-worker"),
                    source: "dev"
                };
                yield {
                    binaryPath: resolve(probeDir, "target/release/devshell-worker"),
                    source: "dev"
                };
            }
            probeDir = resolve(probeDir, "..");
        }
    }

    #supportedEnvVarNames(target: WorkerTarget): string[] {
        return probeLocalWorkerTarget("local", "resolveExecutable").key === target.key
            ? [toTargetEnvVarName(target), "PORTABLE_DEVSHELL_WORKER_PATH"]
            : [toTargetEnvVarName(target)];
    }
}

function isReadableFile(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function toTargetEnvVarName(target: WorkerTarget): string {
    return `PORTABLE_DEVSHELL_WORKER_${target.key.replaceAll("-", "_").toUpperCase()}_PATH`;
}
