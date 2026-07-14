import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createError, errorCodes } from "@portable-devshell/shared";

import { createDefaultControlConfig } from "./ControlConfigDefaults.js";
import { ControlConfigTomlCodec, ControlInstanceTomlCodec, type ControlConfig, type ControlGlobalConfig, type ControlInstanceConfig } from "./codec/ConfigTomlCodec.js";
import { ControlConfigValidator } from "./ControlConfigValidator.js";
import { ControlPathHome } from "../path/ControlPathHome.js";

export class ControlConfigStore {
    readonly #codec: ControlConfigTomlCodec;
    readonly #instanceCodec: ControlInstanceTomlCodec;
    readonly #validator: ControlConfigValidator;

    constructor(options?: { codec?: ControlConfigTomlCodec; instanceCodec?: ControlInstanceTomlCodec; validator?: ControlConfigValidator }) {
        this.#codec = options?.codec ?? new ControlConfigTomlCodec();
        this.#instanceCodec = options?.instanceCodec ?? new ControlInstanceTomlCodec();
        this.#validator = options?.validator ?? new ControlConfigValidator();
    }

    async readOrCreate(homeDirectory?: string): Promise<ControlConfig> {
        const paths = new ControlPathHome(homeDirectory);
        let globalConfig: ControlGlobalConfig | undefined;

        try {
            globalConfig = this.#codec.decode(await readFile(paths.configFile, "utf8"));
        } catch (error) {
            if (isStructuredConfigError(error)) {
                throw createError({
                    code: error.code,
                    cause: error,
                    details: {
                        configFile: paths.configFile,
                        ...(readErrorDetails(error) ?? {})
                    },
                    message: error.message,
                    retryable: false
                });
            }

            if (!isFileMissingError(error)) {
                throw createError({
                    code: errorCodes.controlConfigLoadFailed,
                    cause: error,
                    details: { configFile: paths.configFile, phase: "read" },
                    message: `Failed to load control config from ${paths.configFile}.`,
                    retryable: false
                });
            }
        }

        if (globalConfig === undefined) {
            const config = this.#validator.validate(createDefaultControlConfig());
            await this.write(config, homeDirectory);
            return config;
        }

        const config = this.#validator.validate({
            ...globalConfig,
            instances: await this.#readInstances(paths)
        });
        return config;
    }

    async write(config: ControlConfig, homeDirectory?: string): Promise<void> {
        const paths = new ControlPathHome(homeDirectory);
        const validated = this.#validator.validate(config);

        await mkdir(paths.controlHomeDir, { recursive: true });
        await mkdir(paths.instancesDir, { recursive: true });
        await writeFile(paths.configFile, this.#codec.encode(validated), "utf8");
        await this.#writeInstances(paths, validated.instances);
    }

    async #readInstances(paths: ControlPathHome): Promise<ControlInstanceConfig[]> {
        let entries: Array<{ isFile(): boolean; name: string }>;

        try {
            entries = await readdir(paths.instancesDir, { encoding: "utf8", withFileTypes: true });
        } catch (error) {
            if (isFileMissingError(error)) {
                return [];
            }

            throw createError({
                code: errorCodes.controlConfigLoadFailed,
                cause: error,
                details: { configFile: paths.instancesDir, phase: "read" },
                message: `Failed to load instance configs from ${paths.instancesDir}.`,
                retryable: false
            });
        }

        const instances: ControlInstanceConfig[] = [];
        const instanceFiles = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right));

        for (const fileName of instanceFiles) {
            const filePath = join(paths.instancesDir, fileName);

            try {
                instances.push(this.#instanceCodec.decode(await readFile(filePath, "utf8")));
            } catch (error) {
                if (isStructuredConfigError(error)) {
                    throw createError({
                        code: error.code,
                        cause: error,
                        details: {
                            configFile: filePath,
                            ...(readErrorDetails(error) ?? {})
                        },
                        message: error.message,
                        retryable: false
                    });
                }

                throw error;
            }
        }

        return instances;
    }

    async #writeInstances(paths: ControlPathHome, instances: readonly ControlInstanceConfig[]): Promise<void> {
        const activeFiles = new Set<string>();

        for (const instance of instances) {
            const filePath = paths.instanceConfigFile(instance.name);
            activeFiles.add(filePath);
            await writeFile(filePath, this.#instanceCodec.encode(instance), "utf8");
        }

        for (const entry of await readdir(paths.instancesDir, { encoding: "utf8", withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".toml")) {
                continue;
            }

            const filePath = join(paths.instancesDir, entry.name);

            if (!activeFiles.has(filePath)) {
                await rm(filePath, { force: true });
            }
        }
    }
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isStructuredConfigError(
    error: unknown
): error is { code: string; details?: Record<string, unknown>; message: string; retryable: boolean } {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        "message" in error &&
        typeof error.message === "string" &&
        "retryable" in error &&
        typeof error.retryable === "boolean"
    );
}

function readErrorDetails(error: { details?: Record<string, unknown> }): Record<string, unknown> | undefined {
    return typeof error.details === "object" && error.details !== null ? error.details : undefined;
}
