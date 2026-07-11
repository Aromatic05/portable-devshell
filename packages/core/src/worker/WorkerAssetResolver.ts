import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    source: "env" | "release" | "dev" | "installed";
    searchedPaths: string[];
}

const releaseRepositoryEnvVar = "PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY";
const releaseBaseUrlEnvVar = "PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL";
const releaseTagEnvVar = "PORTABLE_DEVSHELL_WORKER_RELEASE_TAG";
const cacheDirectoryEnvVar = "PORTABLE_DEVSHELL_WORKER_CACHE_DIR";
const defaultReleaseRepository = "Aromatic05/portable-devshell";

export class WorkerAssetResolver {
    readonly #moduleDir: string;

    constructor(moduleUrl: string = import.meta.url) {
        this.#moduleDir = dirname(fileURLToPath(moduleUrl));
    }

    async resolve(target: WorkerTarget): Promise<WorkerAsset> {
        const searchedPaths: string[] = [];

        for (const candidate of this.#candidatePaths(target)) {
            searchedPaths.push(candidate.binaryPath);

            if (!isReadableFile(candidate.binaryPath)) {
                continue;
            }

            return {
                target,
                binaryPath: candidate.binaryPath,
                searchedPaths: [...searchedPaths],
                sha256: createHash("sha256").update(await readFile(candidate.binaryPath)).digest("hex"),
                source: candidate.source
            };
        }

        const releaseAsset = await this.#resolveReleaseAsset(target, searchedPaths);
        if (releaseAsset !== undefined) {
            return releaseAsset;
        }

        throw createError({
            code: errorCodes.coreWorkerAssetUnavailable,
            details: {
                envVarNames: this.#supportedEnvVarNames(target),
                releaseBaseUrlEnvVar,
                releaseRepositoryEnvVar,
                releaseTagEnvVar,
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

        if (hostTargetMatches) {
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

        const devshellHome = process.env.PORTABLE_DEVSHELL_HOME ?? resolve(homedir(), ".devshell");
        yield {
            binaryPath: resolve(devshellHome, "bin", `devshell-worker-${target.key}`),
            source: "installed"
        };
    }

    async #resolveReleaseAsset(target: WorkerTarget, searchedPaths: string[]): Promise<WorkerAsset | undefined> {
        const releaseBaseUrl = this.#resolveReleaseBaseUrl();
        const releaseTag = this.#resolveReleaseTag();

        if (releaseBaseUrl === undefined || releaseTag === undefined) {
            return undefined;
        }

        const assetBaseName = `devshell-worker-${target.key}`;
        const releaseDirectoryUrl = `${releaseBaseUrl}/${releaseTag}`;
        const shaUrl = `${releaseDirectoryUrl}/${assetBaseName}.sha256`;
        const binaryUrl = `${releaseDirectoryUrl}/${assetBaseName}`;
        searchedPaths.push(shaUrl, binaryUrl);

        const expectedSha = await this.#fetchReleaseSha256(target, shaUrl, searchedPaths);
        const cacheDirectory = resolve(this.#resolveCacheDirectory(), releaseTag, target.key, expectedSha);
        const binaryPath = resolve(cacheDirectory, "devshell-worker");
        const shaPath = resolve(cacheDirectory, "devshell-worker.sha256");
        const cachedSha = await readInstalledSha(binaryPath, shaPath);

        if (cachedSha === expectedSha) {
            return {
                target,
                binaryPath,
                searchedPaths: [...searchedPaths],
                sha256: expectedSha,
                source: "release"
            };
        }

        await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
        const payload = await this.#fetchReleaseBinary(target, binaryUrl, searchedPaths);
        const actualSha = createHash("sha256").update(payload).digest("hex");

        if (actualSha !== expectedSha) {
            throw createError({
                code: errorCodes.coreWorkerAssetUnavailable,
                details: {
                    actualSha256: actualSha,
                    downloadUrl: binaryUrl,
                    expectedSha256: expectedSha,
                    searchedPaths,
                    targetKey: target.key
                },
                message: `Worker release asset checksum mismatch for target ${target.key}.`,
                retryable: false
            });
        }

        const tmpBinaryPath = `${binaryPath}.tmp`;
        const tmpShaPath = `${shaPath}.tmp`;
        await writeFile(tmpBinaryPath, payload, { mode: 0o755 });
        await chmod(tmpBinaryPath, 0o755);
        await writeFile(tmpShaPath, `${expectedSha}\n`, { mode: 0o600 });
        await rename(tmpBinaryPath, binaryPath);
        await rename(tmpShaPath, shaPath);

        return {
            target,
            binaryPath,
            searchedPaths: [...searchedPaths],
            sha256: expectedSha,
            source: "release"
        };
    }

    async #fetchReleaseSha256(target: WorkerTarget, url: string, searchedPaths: string[]): Promise<string> {
        let response: Response;
        try {
            response = await fetch(url);
        } catch (error) {
            throw createError({
                code: errorCodes.coreWorkerAssetUnavailable,
                cause: error,
                details: {
                    downloadUrl: url,
                    searchedPaths,
                    targetKey: target.key
                },
                message: `Worker release checksum download failed for target ${target.key}.`,
                retryable: false
            });
        }

        if (!response.ok) {
            throw createError({
                code: errorCodes.coreWorkerAssetUnavailable,
                details: {
                    downloadUrl: url,
                    httpStatus: response.status,
                    searchedPaths,
                    targetKey: target.key
                },
                message: `Worker release checksum is unavailable for target ${target.key}.`,
                retryable: false
            });
        }

        const text = await response.text();
        const sha256 = text.trim().split(/\s+/u)[0] ?? "";
        if (!/^[a-f0-9]{64}$/u.test(sha256)) {
            throw createError({
                code: errorCodes.coreWorkerAssetUnavailable,
                details: {
                    downloadUrl: url,
                    searchedPaths,
                    targetKey: target.key
                },
                message: `Worker release checksum is invalid for target ${target.key}.`,
                retryable: false
            });
        }

        return sha256;
    }

    async #fetchReleaseBinary(target: WorkerTarget, url: string, searchedPaths: string[]): Promise<Buffer> {
        let response: Response;
        try {
            response = await fetch(url);
        } catch (error) {
            throw createError({
                code: errorCodes.coreWorkerAssetUnavailable,
                cause: error,
                details: {
                    downloadUrl: url,
                    searchedPaths,
                    targetKey: target.key
                },
                message: `Worker release asset download failed for target ${target.key}.`,
                retryable: false
            });
        }

        if (!response.ok) {
            throw createError({
                code: errorCodes.coreWorkerAssetUnavailable,
                details: {
                    downloadUrl: url,
                    httpStatus: response.status,
                    searchedPaths,
                    targetKey: target.key
                },
                message: `Worker release asset is unavailable for target ${target.key}.`,
                retryable: false
            });
        }

        return Buffer.from(await response.arrayBuffer());
    }

    #resolveReleaseBaseUrl(): string | undefined {
        const explicitBaseUrl = process.env[releaseBaseUrlEnvVar];
        if (explicitBaseUrl !== undefined && explicitBaseUrl.length > 0) {
            return explicitBaseUrl.replace(/\/+$/u, "");
        }

        const repository = process.env[releaseRepositoryEnvVar] ?? defaultReleaseRepository;
        return repository.length > 0 ? `https://github.com/${repository.replace(/^\/+|\/+$/gu, "")}/releases/download` : undefined;
    }

    #resolveReleaseTag(): string | undefined {
        const explicitTag = process.env[releaseTagEnvVar];
        if (explicitTag !== undefined && explicitTag.length > 0) {
            return explicitTag;
        }

        let probeDir = this.#moduleDir;
        for (let depth = 0; depth < 8; depth += 1) {
            const packageJsonPath = resolve(probeDir, "package.json");
            if (isReadableFile(packageJsonPath)) {
                const raw = readPackageJsonField(packageJsonPath, "name");
                if (raw === "portable-devshell") {
                    const version = readPackageJsonField(packageJsonPath, "version");
                    if (typeof version === "string" && version.length > 0) {
                        return `v${version}`;
                    }
                }
            }

            probeDir = resolve(probeDir, "..");
        }

        return undefined;
    }

    #resolveCacheDirectory(): string {
        const explicitCacheDirectory = process.env[cacheDirectoryEnvVar];
        return explicitCacheDirectory !== undefined && explicitCacheDirectory.length > 0
            ? explicitCacheDirectory
            : resolve(homedir(), ".devshell", "release-cache", "workers");
    }

    #supportedEnvVarNames(target: WorkerTarget): string[] {
        return [toTargetEnvVarName(target)];
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

async function readInstalledSha(binaryPath: string, shaPath: string): Promise<string | undefined> {
    try {
        const [binary, sha] = await Promise.all([readFile(binaryPath), readFile(shaPath, "utf8")]);
        const actual = createHash("sha256").update(binary).digest("hex");
        return actual === sha.trim() ? actual : undefined;
    } catch {
        return undefined;
    }
}

function readPackageJsonField(path: string, field: string): unknown {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        return parsed[field];
    } catch {
        return undefined;
    }
}
