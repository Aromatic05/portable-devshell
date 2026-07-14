import { createError, errorCodes } from "@portable-devshell/shared";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { LocalWorkerInstallerUnix } from "./LocalWorkerInstallerUnix.js";
import { LocalWorkerInstallerWindows } from "./LocalWorkerInstallerWindows.js";

export interface LocalWorkerInstallResult {
    executablePath: string;
    sha256: string;
}

export class LocalWorkerInstaller {
    readonly #unix = new LocalWorkerInstallerUnix();
    readonly #windows = new LocalWorkerInstallerWindows();

    async ensure(devshellHomeDirectory: string, asset: WorkerAsset, target: WorkerTarget): Promise<string> {
        return (await this.ensureInstalled(devshellHomeDirectory, asset, target)).executablePath;
    }

    async ensureInstalled(
        devshellHomeDirectory: string,
        asset: WorkerAsset,
        target: WorkerTarget
    ): Promise<LocalWorkerInstallResult> {
        if (asset.target.key !== target.key) {
            throw createError({
                code: errorCodes.coreWorkerProvisionFailed,
                details: {
                    assetTargetKey: asset.target.key,
                    targetKey: target.key
                },
                message: "Resolved worker asset target does not match install target.",
                retryable: false
            });
        }

        return target.os === "windows"
            ? await this.#windows.ensureInstalled(devshellHomeDirectory, asset, target)
            : await this.#unix.ensureInstalled(devshellHomeDirectory, asset, target);
    }
}