import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createError, errorCodes } from "@portable-devshell/shared";

import { createDefaultControlConfig } from "./ControlConfigDefaults.js";
import { ControlConfigTomlCodec, type ControlConfig } from "./ControlConfigTomlCodec.js";
import { ControlConfigValidator } from "./ControlConfigValidator.js";
import { ControlPathHome } from "../path/ControlPathHome.js";

export class ControlConfigStore {
    readonly #codec: ControlConfigTomlCodec;
    readonly #validator: ControlConfigValidator;

    constructor(options?: { codec?: ControlConfigTomlCodec; validator?: ControlConfigValidator }) {
        this.#codec = options?.codec ?? new ControlConfigTomlCodec();
        this.#validator = options?.validator ?? new ControlConfigValidator();
    }

    async readOrCreate(homeDirectory?: string): Promise<ControlConfig> {
        const paths = new ControlPathHome(homeDirectory);
        let source: string | undefined;

        try {
            source = await readFile(paths.configFile, "utf8");
        } catch (error) {
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

        if (source !== undefined) {
            try {
                return this.#validator.validate(this.#codec.decode(source));
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

                throw error;
            }
        }

        const config = this.#validator.validate(createDefaultControlConfig());
        await this.write(config, homeDirectory);
        return config;
    }

    async write(config: ControlConfig, homeDirectory?: string): Promise<void> {
        const paths = new ControlPathHome(homeDirectory);
        const validated = this.#validator.validate(config);

        await mkdir(paths.controlHomeDir, { recursive: true });
        await writeFile(paths.configFile, this.#codec.encode(validated), "utf8");
    }
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isStructuredConfigError(error: unknown): error is { code: string; details?: Record<string, unknown>; message: string } {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        "message" in error &&
        typeof error.message === "string"
    );
}

function readErrorDetails(error: { details?: Record<string, unknown> }): Record<string, unknown> | undefined {
    return typeof error.details === "object" && error.details !== null ? error.details : undefined;
}
