import type { ExtensionInvocationContext } from "@portable-devshell/extension";
import type {
    ExtensionCommandWireResult,
    ExtensionRemoveResult,
    ExtensionRuntimeRecord,
    JsonValue
} from "@portable-devshell/shared";

import type { ExtensionControlPort } from "./ExtensionRouteModule.js";
import type { ExtensionHost } from "./ExtensionHost.js";
import type { ExtensionInstallService } from "./ExtensionInstallService.js";

export class ExtensionControlService implements ExtensionControlPort {
    readonly #host: ExtensionHost;
    readonly #installer: ExtensionInstallService;

    constructor(options: { host: ExtensionHost; installer: ExtensionInstallService }) {
        this.#host = options.host;
        this.#installer = options.installer;
    }

    async call(
        id: string,
        operation: string,
        input: JsonValue | undefined,
        context: ExtensionInvocationContext
    ): Promise<JsonValue> {
        return await this.#host.dispatchRpc(id, operation, input, context) as JsonValue;
    }

    async command(
        id: string,
        argv: readonly string[],
        context: ExtensionInvocationContext
    ): Promise<ExtensionCommandWireResult> {
        return await this.#host.dispatchCommand(id, argv, context) as ExtensionCommandWireResult;
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
