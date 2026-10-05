import { WORKER_GENERATION_RETENTION_MS } from "../../Config.js";
import { resolve } from "node:path";
import { accessSync, constants } from "node:fs";

import { RemoteError, runtimeErrorCodes } from "@portable-devshell/shared";

import { WorkerBinary } from "../../../Binary.js";
import { type SpawnFunction } from "../../../../transport/endpoint/channel/worker/Command.js";
import { createCommandContext, createProviderError } from "../../../../transport/endpoint/channel/worker/Error.js";
import { LocalConnection, createLocalWorkerEnvironment } from "../../../../transport/endpoint/channel/Local.js";
import { WorkerAssetResolver } from "../../Asset.js";
import { resolveWorkerDevshellHomeDirectory } from "../../Home.js";
import {
    workerInstalledAliasFileName,
    probeLocalWorkerTarget,
} from "../../Target.js";
import {
    WorkerInstallerLocal,
    type WorkerInstallerLocalResult,
} from "../Local.js";

export interface LocalInstallOptions {
    installer?: WorkerInstallerLocal;
    resolver?: WorkerAssetResolver;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
    connection?: LocalConnection;
}

export class LocalInstall {
    readonly #installer: WorkerInstallerLocal;
    readonly #resolver: WorkerAssetResolver;
    readonly #workerBinary: WorkerBinary;
    readonly connection: LocalConnection;

    constructor(options: LocalInstallOptions = {}) {
        this.#installer =
            options.installer ??
            new WorkerInstallerLocal({
                retentionMs: WORKER_GENERATION_RETENTION_MS,
            });
        this.#resolver = options.resolver ?? new WorkerAssetResolver();
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.connection =
            options.connection ??
            new LocalConnection({ spawnFunction: options.spawnFunction });
    }

    get workerBinary(): WorkerBinary {
        return this.#workerBinary;
    }

    async installWorker(): Promise<void> {
        const installCommand = new WorkerBinary(
            (await this.provisionExecutable()).executablePath,
        ).buildInstallCommand();
        const context = createCommandContext({
            command: [installCommand.command, ...installCommand.args],
            operation: "installWorker",
            provider: "local",
        });
        const result = await this.connection.runCommand("installWorker", context.command);
        if (result.exitCode !== 0) {
            throw createProviderError(
                context,
                new Error(
                    result.stderr || result.stdout || "worker install check failed",
                ),
                { errorCode: runtimeErrorCodes.workerProvisionFailed, result },
            );
        }
    }

    async resolveActiveExecutable(env?: NodeJS.ProcessEnv): Promise<string> {
        if (this.#workerBinary.executable !== "devshell-worker")
            return this.#workerBinary.executable;
        const environment = createLocalWorkerEnvironment(env);
        const home = resolveWorkerDevshellHomeDirectory(environment);
        const target = probeLocalWorkerTarget();
        const executable =
            target.os === "windows"
                ? resolve(home, "bin", workerInstalledAliasFileName(target))
                : resolve(home, "bin", "devshell-worker");
        if (isReadableFile(executable)) return executable;
        return (await this.provisionExecutable(env)).executablePath;
    }

    async provisionExecutable(
        env?: NodeJS.ProcessEnv,
    ): Promise<WorkerInstallerLocalResult> {
        if (this.#workerBinary.executable !== "devshell-worker") {
            return { executablePath: this.#workerBinary.executable, sha256: "" };
        }
        const environment = createLocalWorkerEnvironment(env);
        const home = resolveWorkerDevshellHomeDirectory(environment);
        const target = probeLocalWorkerTarget();
        const context = createCommandContext({
            command: ["devshell-worker"],
            operation: "resolveExecutable",
            provider: "local",
        });
        const asset = await this.#resolver.resolve(target, environment).catch(
            (error) => {
                if (error instanceof RemoteError) throw error;
                throw createProviderError(context, error);
            },
        );
        return await this.#installer
            .ensureInstalled(home, asset, target)
            .catch((error) => {
                throw createProviderError(context, error, {
                    errorCode: runtimeErrorCodes.workerProvisionFailed,
                });
            });
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
