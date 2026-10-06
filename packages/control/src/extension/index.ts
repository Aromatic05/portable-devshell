import type {
    ExtensionControlPort,
    ExtensionRuntime,
    ExtensionRuntimeOptions,
} from "./Api.js";
import { ExtensionHost } from "./host/index.js";
import { ExtensionInstallService } from "./install/index.js";
import { ExtensionControlService } from "./manager/index.js";

class ExtensionRuntimeState extends ExtensionHost implements ExtensionRuntime {
    readonly control: ExtensionControlPort;
    readonly #installer: ExtensionInstallService;
    readonly #paths: ExtensionRuntimeOptions["paths"];

    constructor(options: ExtensionRuntimeOptions) {
        super(options);
        this.#paths = options.paths;
        this.#installer = new ExtensionInstallService({
            host: this,
            paths: options.paths,
        });
        this.control = new ExtensionControlService({
            host: this,
            installer: this.#installer,
        });
    }

    generationDirectory(id: string, generation: string): string {
        return this.#paths.generationDirectory(id, generation);
    }

    async installBuiltin(
        id: string,
        sourcePath: string,
    ) {
        return await this.#installer.installBuiltin(id, sourcePath);
    }
}

export function createExtensionRuntime(
    options: ExtensionRuntimeOptions,
): ExtensionRuntime {
    return new ExtensionRuntimeState(options);
}
