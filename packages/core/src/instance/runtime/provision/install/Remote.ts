import type { WorkerConnection } from "../../../transport/endpoint/channel/worker/index.js";
import { createCommandContext, createProviderError } from "../../../transport/endpoint/channel/worker/Error.js";
import { buildInspectScript, buildInstallScript, buildRemoteExecutablePath } from "./Script.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
    RemoteError,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import { WorkerAssetResolver } from "../Asset.js";
import { WORKER_GENERATION_RETENTION_DAYS } from "../Config.js";
import { probeRemoteWorkerTarget } from "../Target.js";
import type { WorkerCommandInteractiveSession } from "../../../transport/endpoint/channel/worker/Command.js";

export interface WorkerInstallerRemoteOptions {
    resolver?: WorkerAssetResolver;
    connection: WorkerConnection;
    provider: string;
}

export class WorkerInstallerRemote {
    readonly #resolver: WorkerAssetResolver;
    readonly #connection: WorkerInstallerRemoteOptions["connection"];
    readonly #provider: string;
    #homeDirectoryPromise?: Promise<string>;
    #installPromise?: Promise<string>;

    constructor(options: WorkerInstallerRemoteOptions) {
        this.#resolver = options.resolver ?? new WorkerAssetResolver();
        this.#connection = options.connection;
        this.#provider = options.provider;
    }

    async ensure(executable: string, interactiveSession?: WorkerCommandInteractiveSession): Promise<string> {
        if (executable !== "devshell-worker") {
            return executable;
        }

        if (this.#installPromise === undefined) {
            this.#installPromise = this.#installDefaultWorker(interactiveSession).finally(() => {
                this.#installPromise = undefined;
            });
        }

        return await this.#installPromise;
    }

    async #installDefaultWorker(interactiveSession?: WorkerCommandInteractiveSession): Promise<string> {
        const target = await probeRemoteWorkerTarget(this.#connection, this.#provider, { interactiveSession });
        const asset = await this.#resolver.resolve(target).catch((error) => {
            if (error instanceof RemoteError) {
                throw error;
            }

            throw createProviderError(
                this.#createContext("resolveExecutable", ["devshell-worker"]),
                error,
            );
        });
        const homeDirectory = await this.#resolveHomeDirectory(interactiveSession);

        if (
            await this.#isRemoteWorkerCurrent(
                homeDirectory,
                target.key,
                asset.sha256,
                interactiveSession,
            )
        ) {
            return buildRemoteExecutablePath(homeDirectory);
        }

        const binary = await readFile(asset.binaryPath).catch((error) => {
            throw createProviderError(
                this.#createContext("resolveExecutable", ["devshell-worker"]),
                error,
            );
        });
        const actualSha256 = createHash("sha256").update(binary).digest("hex");
        if (actualSha256 !== asset.sha256) {
            throw createProviderError(
                this.#createContext("installWorker", [asset.binaryPath]),
                new Error(
                    `worker bundle checksum mismatch: expected ${asset.sha256}, got ${actualSha256}`,
                ),
                { errorCode: runtimeErrorCodes.workerProvisionFailed },
            );
        }
        const commandLine = buildInstallScript(
            homeDirectory,
            target.key,
            asset.sha256,
            WORKER_GENERATION_RETENTION_DAYS,
        );
        const context = this.#createContext("installWorker", [
            "sh",
            "-lc",
            commandLine,
        ]);
        const result = await this.#connection.runCommand(context.operation, context.command, { input: binary, interactiveSession });
        if (result.exitCode !== 0) {
            throw createProviderError(
                context,
                new Error(
                    result.stderr || result.stdout || "worker install failed",
                ),
                {
                    errorCode: runtimeErrorCodes.workerProvisionFailed,
                    result,
                },
            );
        }

        return buildRemoteExecutablePath(homeDirectory);
    }

    async #isRemoteWorkerCurrent(
        homeDirectory: string,
        targetKey: string,
        sha256: string,
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<boolean> {
        const commandLine = buildInspectScript(
            homeDirectory,
            targetKey,
            sha256,
            WORKER_GENERATION_RETENTION_DAYS,
        );
        const context = this.#createContext("installWorker", [
            "sh",
            "-lc",
            commandLine,
        ]);
        const result = await this.#connection.runCommand(context.operation, context.command, { interactiveSession });

        if (result.exitCode !== 0) {
            throw createProviderError(
                context,
                new Error(
                    result.stderr ||
                        result.stdout ||
                        "worker install check failed",
                ),
                {
                    errorCode: runtimeErrorCodes.workerProvisionFailed,
                    result,
                },
            );
        }

        const status = result.stdout.trim();
        if (status === "ready") {
            return true;
        }
        if (status === "missing") {
            return false;
        }

        throw createProviderError(
            context,
            new Error(
                `unexpected worker install check result: ${status || "empty"}`,
            ),
            {
                errorCode: runtimeErrorCodes.workerProvisionFailed,
                result,
            },
        );
    }

    async #resolveHomeDirectory(interactiveSession?: WorkerCommandInteractiveSession): Promise<string> {
        if (this.#homeDirectoryPromise !== undefined) {
            return await this.#homeDirectoryPromise;
        }

        const promise = this.#readHomeDirectory(interactiveSession).catch((error) => {
            if (this.#homeDirectoryPromise === promise) {
                this.#homeDirectoryPromise = undefined;
            }
            throw error;
        });
        this.#homeDirectoryPromise = promise;
        return await promise;
    }

    async #readHomeDirectory(interactiveSession?: WorkerCommandInteractiveSession): Promise<string> {
        const commandLine =
            'printf %s "${HOME:?HOME is required to install the worker}"';
        const context = this.#createContext("installWorker", [
            "sh",
            "-lc",
            commandLine,
        ]);
        const result = await this.#connection.runCommand(context.operation, context.command, { interactiveSession });

        if (result.exitCode !== 0) {
            throw createProviderError(
                context,
                new Error(
                    result.stderr || result.stdout || "failed to resolve HOME",
                ),
                { errorCode: runtimeErrorCodes.workerProvisionFailed, result },
            );
        }

        const homeDirectory = result.stdout.trim();
        if (homeDirectory.length === 0) {
            throw createProviderError(
                context,
                new Error("HOME is required to install the worker"),
                { errorCode: runtimeErrorCodes.workerProvisionFailed, result },
            );
        }

        return homeDirectory;
    }

    #createContext(operation: string, command: readonly string[]) {
        return createCommandContext({ operation, command, provider: this.#provider });
    }
}
