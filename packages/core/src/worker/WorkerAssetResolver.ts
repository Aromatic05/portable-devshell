import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createError, errorCodes } from "@portable-devshell/shared";
import { ensureWorkerExecutablePermissions } from "./platform/WorkerExecutablePermissions.js";
import { resolveWorkerDevshellHomeDirectory } from "./platform/WorkerHomeDirectory.js";

import type { WorkerTarget } from "./target/WorkerTarget.js";
import { supportedWorkerTargetKeys } from "./target/WorkerTarget.js";
import { probeLocalWorkerTarget } from "./target/WorkerTargetProbe.js";
import {
    workerAssetFileName,
    workerBinaryFileName,
    workerInstalledAliasFileName
} from "./target/WorkerTargetBinary.js";

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

    async resolve(target: WorkerTarget, environment: NodeJS.ProcessEnv = process.env): Promise<WorkerAsset> {
        const searchedPaths: string[] = [];

        for (const candidate of this.#candidatePaths(target, environment)) {
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

        const releaseAsset = await this.#resolveReleaseAsset(target, searchedPaths, environment);
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

    *#candidatePaths(target: WorkerTarget, environment: NodeJS.ProcessEnv): Iterable<{ binaryPath: string; source: WorkerAsset["source"] }> {
        const hostTarget = probeLocalWorkerTarget("local", "resolveExecutable");
        const hostTargetMatches = hostTarget.key === target.key;
        const targetEnvVarName = toTargetEnvVarName(target);
        const targetEnvPath = environment[targetEnvVarName];

        if (targetEnvPath !== undefined && targetEnvPath.length > 0) {
            yield {
                binaryPath: targetEnvPath,
                source: "env"
            };
        }

        if (hostTargetMatches) {
            for (const projectRoot of findPortableDevshellProjectRoots(this.#moduleDir)) {
                yield {
                    binaryPath: resolve(projectRoot, "target", target.rustTarget, "debug", workerBinaryFileName(target)),
                    source: "dev"
                };
                yield {
                    binaryPath: resolve(projectRoot, "target", target.rustTarget, "release", workerBinaryFileName(target)),
                    source: "dev"
                };
                if (target.os !== "linux") {
                    yield {
                        binaryPath: resolve(projectRoot, "target", "debug", workerBinaryFileName(target)),
                        source: "dev"
                    };
                    yield {
                        binaryPath: resolve(projectRoot, "target", "release", workerBinaryFileName(target)),
                        source: "dev"
                    };
                }
            }
        }

        const devshellHome = resolveWorkerDevshellHomeDirectory(environment);
        yield {
            binaryPath: resolve(devshellHome, "bin", workerInstalledAliasFileName(target)),
            source: "installed"
        };
    }

    async #resolveReleaseAsset(
        target: WorkerTarget,
        searchedPaths: string[],
        environment: NodeJS.ProcessEnv
    ): Promise<WorkerAsset | undefined> {
        const releaseDirectoryUrl = this.#resolveReleaseDirectoryUrl(environment);
        const releaseTag = this.#resolveReleaseTag(environment);

        if (releaseDirectoryUrl === undefined || releaseTag === undefined) {
            return undefined;
        }

        const assetBaseName = workerAssetFileName(target);
        const shaUrl = `${releaseDirectoryUrl}/${assetBaseName}.sha256`;
        const binaryUrl = `${releaseDirectoryUrl}/${assetBaseName}`;
        searchedPaths.push(shaUrl, binaryUrl);

        const expectedSha = await this.#fetchReleaseSha256(target, shaUrl, searchedPaths);
        const cacheDirectory = resolve(this.#resolveCacheDirectory(environment), releaseTag, target.key, expectedSha);
        const binaryPath = resolve(cacheDirectory, workerBinaryFileName(target));
        const shaPath = resolve(cacheDirectory, `${workerBinaryFileName(target)}.sha256`);
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
        await ensureWorkerExecutablePermissions(tmpBinaryPath, target);
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
            response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
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
            response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
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

    #resolveReleaseBaseUrl(environment: NodeJS.ProcessEnv): string | undefined {
        const explicitBaseUrl = environment[releaseBaseUrlEnvVar];
        if (explicitBaseUrl !== undefined && explicitBaseUrl.length > 0) {
            return explicitBaseUrl.replace(/\/+$/u, "");
        }

        const repository = environment[releaseRepositoryEnvVar] ?? defaultReleaseRepository;
        return repository.length > 0 ? `https://github.com/${repository.replace(/^\/+|\/+$/gu, "")}/releases/download` : undefined;
    }

    #resolveReleaseDirectoryUrl(environment: NodeJS.ProcessEnv): string | undefined {
        const hasExplicitReleaseSelection = [
            environment[releaseBaseUrlEnvVar],
            environment[releaseRepositoryEnvVar],
            environment[releaseTagEnvVar]
        ].some((value) => value !== undefined && value.length > 0);
        if (!hasExplicitReleaseSelection) {
            const installedDirectory = this.#readInstalledManifestField("workerReleaseDirectoryUrl");
            if (typeof installedDirectory === "string" && installedDirectory.length > 0) {
                return installedDirectory.replace(/\/+$/u, "");
            }
        }

        const releaseBaseUrl = this.#resolveReleaseBaseUrl(environment);
        const releaseTag = this.#resolveReleaseTag(environment);
        return releaseBaseUrl === undefined || releaseTag === undefined
            ? undefined
            : `${releaseBaseUrl}/${releaseTag}`;
    }

    #resolveReleaseTag(environment: NodeJS.ProcessEnv): string | undefined {
        const explicitTag = environment[releaseTagEnvVar];
        if (explicitTag !== undefined && explicitTag.length > 0) {
            return explicitTag;
        }

        let probeDir = this.#moduleDir;
        for (let depth = 0; depth < 12; depth += 1) {
            const packageJsonPath = resolve(probeDir, "package.json");
            if (isReadableFile(packageJsonPath)) {
                const raw = readJsonField(packageJsonPath, "name");
                if (raw === "portable-devshell") {
                    const version = readJsonField(packageJsonPath, "version");
                    if (typeof version === "string" && version.length > 0) {
                        return `v${version}`;
                    }
                }
            }

            const installManifestPath = resolve(probeDir, "portable-devshell-install.json");
            if (isReadableFile(installManifestPath)) {
                const version = readJsonField(installManifestPath, "version");
                if (typeof version === "string" && version.length > 0) {
                    return `v${version}`;
                }
            }

            probeDir = resolve(probeDir, "..");
        }

        return undefined;
    }

    #readInstalledManifestField(field: string): unknown {
        let probeDir = this.#moduleDir;
        for (let depth = 0; depth < 12; depth += 1) {
            const installManifestPath = resolve(probeDir, "portable-devshell-install.json");
            if (isReadableFile(installManifestPath)) {
                return readJsonField(installManifestPath, field);
            }
            probeDir = resolve(probeDir, "..");
        }
        return undefined;
    }

    #resolveCacheDirectory(environment: NodeJS.ProcessEnv): string {
        const explicitCacheDirectory = environment[cacheDirectoryEnvVar];
        return explicitCacheDirectory !== undefined && explicitCacheDirectory.length > 0
            ? explicitCacheDirectory
            : resolve(resolveWorkerDevshellHomeDirectory(environment), "release-cache", "workers");
    }

    #supportedEnvVarNames(target: WorkerTarget): string[] {
        return [toTargetEnvVarName(target)];
    }
}

function findPortableDevshellProjectRoots(start: string): string[] {
    const roots: string[] = [];
    let probeDir = start;
    for (let depth = 0; depth < 16; depth += 1) {
        if (readJsonField(resolve(probeDir, "package.json"), "name") === "portable-devshell") {
            roots.push(probeDir);
        }
        const parent = resolve(probeDir, "..");
        if (parent === probeDir) {
            break;
        }
        probeDir = parent;
    }
    return roots;
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

function readJsonField(path: string, field: string): unknown {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        return parsed[field];
    } catch {
        return undefined;
    }
}