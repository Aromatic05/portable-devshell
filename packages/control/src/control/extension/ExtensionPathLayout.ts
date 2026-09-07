import { homedir } from "node:os";
import { join } from "node:path";

import { ControlPathRuntime } from "@portable-devshell/shared";

import { assertExtensionGeneration, assertExtensionId } from "./ExtensionRegistryModel.js";

export interface ExtensionPathLayoutOptions {
    dataHome?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
    runtimeRoot?: string;
    xdgRuntimeDir?: string;
}

export class ExtensionPathLayout {
    readonly codeRoot: string;
    readonly registryFile: string;
    readonly runtimeRoot: string;
    readonly stateRoot: string;

    constructor(options: ExtensionPathLayoutOptions = {}) {
        const home = options.homeDirectory ?? homedir();
        const environment = options.environment ?? process.env;
        const platform = options.platform ?? process.platform;
        const dataHome = options.dataHome
            ?? environment.XDG_DATA_HOME
            ?? (platform === "win32"
                ? environment.LOCALAPPDATA ?? join(home, "AppData", "Local")
                : join(home, ".local", "share"));
        this.codeRoot = join(dataHome, "portable-devshell", "extensions");
        this.stateRoot = join(home, ".devshell", "control", "extensions");
        this.registryFile = join(this.stateRoot, "registry.json");
        this.runtimeRoot = options.runtimeRoot
            ?? join(
                new ControlPathRuntime(options.xdgRuntimeDir, platform, environment).runtimeDir,
                "extensions"
            );
    }

    generationDirectory(id: string, generation: string): string {
        assertExtensionId(id);
        assertExtensionGeneration(generation);
        return join(this.codeRoot, id, generation);
    }

    manifestFile(id: string, generation: string): string {
        return join(this.generationDirectory(id, generation), "devshell-extension.json");
    }

    runtimeDirectory(id: string, generation: string): string {
        assertExtensionId(id);
        assertExtensionGeneration(generation);
        return join(this.runtimeRoot, id, generation);
    }

    stateDirectory(id: string): string {
        assertExtensionId(id);
        return join(this.stateRoot, "state", id);
    }
}
