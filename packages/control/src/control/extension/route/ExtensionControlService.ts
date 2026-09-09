import type {
    ExtensionRemoveResult,
    ExtensionRuntimeRecord
} from "@portable-devshell/shared";

import type { ExtensionControlPort } from "./ExtensionRouteModule.js";
import type { ExtensionHost } from "../host/ExtensionHost.js";
import type { ExtensionInstallService } from "../install/ExtensionInstallService.js";

export class ExtensionControlService implements ExtensionControlPort {
    readonly #host: ExtensionHost;
    readonly #installer: ExtensionInstallService;

    constructor(options: { host: ExtensionHost; installer: ExtensionInstallService }) {
        this.#host = options.host;
        this.#installer = options.installer;
    }

    async disable(id: string): Promise<void> {
        await this.#host.disable(id);
    }

    async enable(id: string): Promise<void> {
        await this.#host.enable(id);
    }

    async install(sourcePath: string): Promise<ExtensionRuntimeRecord> {
        return await this.#installer.install(sourcePath);
    }

    async installBuiltin(id: string, sourcePath: string): Promise<ExtensionRuntimeRecord> {
        return await this.#installer.installBuiltin(id, sourcePath);
    }

    async list(): Promise<ExtensionRuntimeRecord[]> {
        return await this.#host.list();
    }

    async reload(id: string): Promise<void> {
        await this.#host.reload(id);
    }

    async remove(id: string, purge: boolean): Promise<ExtensionRemoveResult> {
        return await this.#installer.remove(id, purge);
    }
}
