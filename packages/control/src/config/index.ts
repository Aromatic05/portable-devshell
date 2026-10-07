import {
    controlErrorCodes,
    createRemoteError,
    type ControlConfig as ControlConfigDocument,
} from "@portable-devshell/shared";

import { ConfigChangeHub } from "./change/Config.js";
import { ConfigRegistry, createCoreConfigRegistry } from "./domain/Registry.js";
import type { ConfigEditorCoordinator } from "./editor/index.js";
import { ControlConfigMutationLock } from "./engine/Lock.js";
import type { ConfigEngine } from "./engine/index.js";
import { ControlConfigStore } from "./store/index.js";

export interface ControlConfigOptions {
    registry?: ConfigRegistry;
    store?: ControlConfigStore;
}

export class ControlConfig {
    readonly changes = new ConfigChangeHub();
    readonly mutations = new ControlConfigMutationLock();
    readonly registry: ConfigRegistry;
    readonly store: ControlConfigStore;
    #document?: ControlConfigDocument;
    #editor?: ConfigEditorCoordinator;
    #engine?: ConfigEngine;
    #restartRequired = false;

    constructor(options: ControlConfigOptions = {}) {
        this.registry = options.registry ?? createCoreConfigRegistry();
        this.store = options.store ?? new ControlConfigStore({ registry: this.registry });
    }

    get document(): ControlConfigDocument | undefined {
        return this.#document;
    }

    get editor(): ConfigEditorCoordinator {
        if (this.#editor === undefined)
            throw new Error("Control config editor is not composed.");
        return this.#editor;
    }

    get engine(): ConfigEngine {
        if (this.#engine === undefined)
            throw new Error("Control config engine is not composed.");
        return this.#engine;
    }

    get restartRequired(): boolean {
        return this.#restartRequired;
    }

    async load(homeDirectory?: string): Promise<ControlConfigDocument> {
        const document = await this.store.readOrCreate(homeDirectory);
        this.#document = document;
        this.#restartRequired = false;
        return document;
    }

    require(): ControlConfigDocument {
        if (this.#document !== undefined) return this.#document;
        throw createRemoteError({
            code: controlErrorCodes.configLoadFailed,
            message: "Control config is not loaded.",
            retryable: false,
        });
    }

    set(document: ControlConfigDocument): void {
        this.#document = document;
    }

    composeRuntime(engine: ConfigEngine, editor: ConfigEditorCoordinator): void {
        this.#engine = engine;
        this.#editor = editor;
    }

    markRestartRequired(): void {
        this.#restartRequired = true;
    }

    reset(): void {
        this.#document = undefined;
        this.#editor = undefined;
        this.#engine = undefined;
        this.#restartRequired = false;
    }
}
