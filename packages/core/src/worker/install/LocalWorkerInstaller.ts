import { createError, errorCodes } from "@portable-devshell/shared";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { LocalWorkerInstallerUnix } from "./LocalWorkerInstallerUnix.js";
import { LocalWorkerInstallerWindows } from "./LocalWorkerInstallerWindows.js";

export class LocalWorkerInstaller {
    readonly #unix = new LocalWorkerInstallerUnix();
    readonly #windows = new LocalWorkerInstallerWindows();

    async ensure(homeDirectory: string, asset: WorkerAsset, target: WorkerTarget): Promise<string> {
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
            ? await this.#windows.ensure(homeDirectory, asset, target)
            : await this.#unix.ensure(homeDirectory, asset, target);
    }
}