import type { JsonValue } from "@portable-devshell/shared";
import { ConfigEngine, type ConfigEngineOptions } from "../engine/index.js";
import { ConfigDraftValidator } from "./Draft.js";
import { ConfigGlobalPatch } from "./GlobalPatch.js";
import {
    ConfigBatchEditor,
    type ConfigBatchInstancePort,
} from "./Batch.js";

export type { ConfigRuntimeChangeSet } from "../engine/index.js";

export interface ConfigEditorCoordinatorOptions extends ConfigEngineOptions {
    engine?: ConfigEngine;
    instances?: ConfigBatchInstancePort;
}

export class ConfigEditorCoordinator {
    readonly #engine: ConfigEngine;
    readonly #drafts: ConfigDraftValidator;
    readonly #global: ConfigGlobalPatch;
    readonly #batch: ConfigBatchEditor;

    constructor(options: ConfigEditorCoordinatorOptions) {
        this.#engine = options.engine ?? new ConfigEngine(options);
        this.#global = new ConfigGlobalPatch(this.#engine);
        this.#batch = new ConfigBatchEditor(this.#engine, options.instances);
        this.#drafts = new ConfigDraftValidator(this.#engine, options.getRestartControlRequired ?? (() => false));
    }

    getConfigView(): JsonValue {
        return this.#engine.getConfigView();
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        return this.#drafts.validate(params);
    }

    async updateCorePaths(patch: Readonly<Record<string, JsonValue>>): Promise<void> {
        await this.#global.updateCorePaths(patch);
    }

    async updateConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#batch.updateConfig(params);
    }

    async updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#global.updateMcpConfig(params);
    }

    async updateWebConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#global.updateWebConfig(params);
    }
}
