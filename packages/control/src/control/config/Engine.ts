import {
    ConfigInputError,
    MASKED_CONFIG_TOKEN,
    createError,
    errorCodes,
    formatConfigPath,
    normalizeConfigDraft,
    parseConfigDraft,
    toConfigView,
    type ConfigDraft,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";

import { ControlConfigValidator } from "./Validator.js";
import {
    ControlConfigMutationLock,
    type ControlConfigMutationRunner,
} from "./editor/Lock.js";
import {
    buildApplyResult,
    type ConfigApplyChange,
} from "./editor/Result.js";
import {
    ConfigRegistry,
    createCoreConfigRegistry,
    type ConfigDomainDefinition,
} from "./Registry.js";

export interface ConfigRuntimeChangeSet {
    instanceAuth: boolean;
    mcp: boolean;
    web: boolean;
}

export interface ControlConfigWriter {
    write(config: ControlConfig, homeDirectory?: string): Promise<void>;
}

export interface ConfigEngineOptions {
    configStore: ControlConfigWriter;
    getConfig: () => ControlConfig;
    getRestartControlRequired?: () => boolean;
    homeDirectory?: string;
    markRestartControlRequired?: () => void;
    mutationRunner?: ControlConfigMutationRunner;
    registry?: ConfigRegistry;
    runtimeApply?: {
        apply(
            previous: ControlConfig,
            next: ControlConfig,
            changes: ConfigRuntimeChangeSet,
        ): Promise<boolean>;
    };
    runtimePreflight?: {
        assertAvailable(
            previous: ControlConfig,
            next: ControlConfig,
        ): Promise<void>;
    };
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}

export class ConfigEngine {
    readonly #configStore: ControlConfigWriter;
    readonly #getConfig: () => ControlConfig;
    readonly #getRestartControlRequired: () => boolean;
    readonly #homeDirectory?: string;
    readonly #markRestartControlRequired: () => void;
    readonly #mutationRunner: ControlConfigMutationRunner;
    readonly #registry: ConfigRegistry;
    readonly #runtimeApply?: ConfigEngineOptions["runtimeApply"];
    readonly #runtimePreflight: NonNullable<
        ConfigEngineOptions["runtimePreflight"]
    >;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;

    constructor(options: ConfigEngineOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getRestartControlRequired =
            options.getRestartControlRequired ?? (() => false);
        this.#homeDirectory = options.homeDirectory;
        this.#markRestartControlRequired =
            options.markRestartControlRequired ?? (() => undefined);
        this.#mutationRunner =
            options.mutationRunner ?? new ControlConfigMutationLock();
        this.#registry = options.registry ?? createCoreConfigRegistry();
        this.#runtimeApply = options.runtimeApply;
        this.#runtimePreflight =
            options.runtimePreflight ?? noopRuntimePreflight;
        this.#setConfig = options.setConfig;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    get current(): ControlConfig {
        return this.#getConfig();
    }

    get domains(): readonly ConfigDomainDefinition[] {
        return this.#registry.list();
    }

    requireDomain(id: string): ConfigDomainDefinition {
        return this.#registry.require(id);
    }

    getConfigView(): JsonValue {
        return toConfigView(
            this.#getConfig(),
            this.#getRestartControlRequired(),
        ) as unknown as JsonValue;
    }

    validateConfig(config: ControlConfig): ControlConfig {
        return this.#validator.validate(config);
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        const draft = this.readInput(() =>
            parseConfigDraft(stripConfigViewMetadata(params)),
        );
        const config = this.readInput(() =>
            normalizeConfigDraft(this.#resolveMaskedTokens(draft)),
        );
        return toConfigView(
            this.validateConfig(config),
            this.#getRestartControlRequired(),
        ) as unknown as JsonValue;
    }

    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        return await this.#mutationRunner.runExclusive(operation);
    }

    async preflight(previous: ControlConfig, next: ControlConfig): Promise<void> {
        await this.#runtimePreflight.assertAvailable(previous, next);
    }

    async persist(config: ControlConfig): Promise<void> {
        await this.#configStore.write(config, this.#homeDirectory);
        this.#setConfig(config);
    }

    async applyRuntimeOrRestore(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet,
    ): Promise<boolean> {
        if (this.#runtimeApply === undefined) return false;
        try {
            return await this.#runtimeApply.apply(previous, next, changes);
        } catch (error) {
            await this.persist(previous);
            throw error;
        }
    }

    async rollbackRuntime(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet,
    ): Promise<void> {
        if (this.#runtimeApply === undefined) return;
        await this.#runtimeApply.apply(previous, next, changes);
    }

    finalizeApplyResult(
        previous: ControlConfig,
        next: ControlConfig,
        changes: readonly ConfigApplyChange[],
        hotApplied = false,
    ): JsonValue {
        const result = buildApplyResult(
            previous,
            next,
            [...changes],
            hotApplied,
        );
        if (result.restartControlRequired) this.#markRestartControlRequired();
        return result as unknown as JsonValue;
    }

    readInput<T>(read: () => T): T {
        try {
            return read();
        } catch (error) {
            if (!(error instanceof ConfigInputError)) throw error;
            throw createError({
                code: errorCodes.controlConfigInvalid,
                cause: error,
                details: {
                    fieldPath: formatConfigPath(error.issue.path),
                    issueCode: error.issue.code,
                    phase: error.issue.phase,
                },
                message: error.message,
                retryable: false,
            });
        }
    }

    #resolveMaskedTokens(draft: ConfigDraft): ConfigDraft {
        const current = this.#getConfig();
        const webAuth = current.web.auth;
        const web =
            draft.web?.token === MASKED_CONFIG_TOKEN && webAuth.mode === "token"
                ? { ...draft.web, token: webAuth.token }
                : draft.web;
        const instances = draft.instances?.map((instance) => {
            if (instance.mcp?.token !== MASKED_CONFIG_TOKEN) return instance;
            const existing = current.instances.find(
                (candidate) => candidate.name === instance.name,
            );
            if (existing?.mcp.auth.mode !== "token") return instance;
            return {
                ...instance,
                mcp: { ...instance.mcp, token: existing.mcp.auth.token },
            };
        });
        return { ...draft, web, instances };
    }
}

const noopRuntimePreflight = {
    async assertAvailable(): Promise<void> {},
};

function stripConfigViewMetadata(
    value: JsonValue | undefined,
): JsonValue | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return value;
    const { restartControlRequired: _restartControlRequired, ...config } =
        value;
    return config;
}
