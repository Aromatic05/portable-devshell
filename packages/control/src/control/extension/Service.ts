import {
    createError,
    errorCodes,
    type ExtensionRemoveResult,
    type ExtensionRuntimeRecord,
} from "@portable-devshell/shared";

import type { ExtensionControlPort } from "./Route.js";
import type { ExtensionHost } from "./Host.js";
import type { ExtensionInstallService } from "./install/Service.js";

export class ExtensionControlService implements ExtensionControlPort {
    readonly #host: ExtensionHost;
    readonly #installer: ExtensionInstallService;
    readonly #requiredBuiltinIds: ReadonlySet<string>;

    constructor(options: {
        host: ExtensionHost;
        installer: ExtensionInstallService;
        requiredBuiltinIds?: ReadonlySet<string>;
    }) {
        this.#host = options.host;
        this.#installer = options.installer;
        this.#requiredBuiltinIds = new Set(options.requiredBuiltinIds ?? []);
    }

    async disable(id: string): Promise<void> {
        if (this.#requiredBuiltinIds.has(id))
            throw requiredBuiltinDisableError(id);
        await this.#host.disable(id);
    }

    async enable(id: string): Promise<void> {
        await this.#host.enable(id);
    }

    async install(sourcePath: string): Promise<ExtensionRuntimeRecord> {
        return await this.#installer.install(sourcePath);
    }

    async installBuiltin(
        id: string,
        sourcePath: string,
    ): Promise<ExtensionRuntimeRecord> {
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

function requiredBuiltinDisableError(id: string): Error {
    return createError({
        code: errorCodes.controlExtensionAccessDenied,
        details: { extensionId: id, operation: "disable" },
        message: `Extension ${id} is a required builtin and cannot be disabled.`,
        retryable: false,
    });
}
