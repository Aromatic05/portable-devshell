import type {
    ExtensionControlPort,
    ExtensionRuntime,
} from "./Api.js";
import type { ConfigRegistry } from "../config/Api.js";
import {
    ExtensionLoader,
    type ExtensionLoaderOptions,
} from "./discovery/Loader.js";
import {
    ExtensionHost,
} from "./host/index.js";
import { ExtensionInstallService } from "./install/index.js";
import { ExtensionControlService } from "./manager/index.js";
import { createControlExtensionPointRegistry } from "./registration/Points.js";
import {
    ExtensionPathLayout,
    type ExtensionPathLayoutOptions,
} from "./state/Layout.js";
import { ExtensionRegistryStore } from "./state/Store.js";

type ExtensionRuntimeOptions = Omit<
    ExtensionLoaderOptions,
    "paths" | "points"
> & {
    configRegistry?: ConfigRegistry;
    pathOptions?: ExtensionPathLayoutOptions;
};

class ExtensionRuntimeState extends ExtensionHost implements ExtensionRuntime {
    readonly control: ExtensionControlPort;
    readonly #installer: ExtensionInstallService;
    readonly #paths: ExtensionPathLayout;

    constructor(options: ExtensionRuntimeOptions) {
        const { configRegistry, pathOptions, ...loaderOptions } = options;
        const paths = new ExtensionPathLayout(pathOptions);
        const loader = new ExtensionLoader({
            ...loaderOptions,
            paths,
            points: createControlExtensionPointRegistry(),
        });
        super({
            configRegistry,
            loader,
            registry: new ExtensionRegistryStore(paths.registryFile),
        });
        this.#paths = paths;
        this.#installer = new ExtensionInstallService({
            host: this,
            paths,
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
