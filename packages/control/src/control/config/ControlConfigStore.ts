import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    ConfigInputError,
    ControlPathHome,
    createDefaultControlConfig,
    createError,
    errorCodes,
    formatConfigPath,
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    type ControlConfig,
    type ControlGlobalConfig,
    type ControlInstanceConfig
} from "@portable-devshell/shared";

import { ControlConfigValidator } from "./ControlConfigValidator.js";
import { ControlGlobalTomlDocument, ControlInstanceTomlDocument } from "./toml/ControlConfigTomlDocument.js";
import { ControlConfigTomlCodec } from "./toml/ControlConfigTomlCodec.js";

export interface ControlConfigStoreOptions {
    globalDocument?: ControlGlobalTomlDocument;
    instanceDocument?: ControlInstanceTomlDocument;
    tomlCodec?: ControlConfigTomlCodec;
    validator?: ControlConfigValidator;
}

export class ControlConfigStore {
    readonly #globalDocument: ControlGlobalTomlDocument;
    readonly #instanceDocument: ControlInstanceTomlDocument;
    readonly #tomlCodec: ControlConfigTomlCodec;
    readonly #validator: ControlConfigValidator;

    constructor(options: ControlConfigStoreOptions = {}) {
        this.#globalDocument = options.globalDocument ?? new ControlGlobalTomlDocument();
        this.#instanceDocument = options.instanceDocument ?? new ControlInstanceTomlDocument();
        this.#tomlCodec = options.tomlCodec ?? new ControlConfigTomlCodec();
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    async readOrCreate(homeDirectory?: string): Promise<ControlConfig> {
        const paths = new ControlPathHome(homeDirectory);
        let globalConfig: ControlGlobalConfig | undefined;

        try {
            const source = await readFile(paths.configFile, "utf8");
            await secureFile(paths.configFile);
            const draft = this.#globalDocument.decode(this.#tomlCodec.decode(source));
            globalConfig = normalizeConfigGlobalDraft(draft);
        } catch (error) {
            if (!isFileMissingError(error)) throw attachConfigFile(error, paths.configFile);
        }

        if (globalConfig === undefined) {
            const config = this.#validator.validate(createDefaultControlConfig());
            await this.write(config, homeDirectory);
            return config;
        }

        return this.#validator.validate({
            ...globalConfig,
            instances: await this.#readInstances(paths)
        });
    }

    async write(config: ControlConfig, homeDirectory?: string): Promise<void> {
        const paths = new ControlPathHome(homeDirectory);
        const validated = this.#validator.validate(config);
        const globalSource = this.#tomlCodec.encode(this.#globalDocument.encode(validated));
        const instanceSources = validated.instances.map((instance) => ({
            filePath: paths.instanceConfigFile(instance.name),
            source: this.#tomlCodec.encode(this.#instanceDocument.encode(instance))
        }));

        await secureDirectory(paths.controlHomeDir);
        await secureDirectory(paths.instancesDir);
        await atomicWriteFile(paths.configFile, globalSource);
        for (const entry of instanceSources) await atomicWriteFile(entry.filePath, entry.source);
        await this.#removeStaleInstances(paths, new Set(instanceSources.map((entry) => entry.filePath)));
    }

    async #readInstances(paths: ControlPathHome): Promise<ControlInstanceConfig[]> {
        let entries: Array<{ isFile(): boolean; name: string }>;
        try {
            entries = await readdir(paths.instancesDir, { encoding: "utf8", withFileTypes: true });
            if (process.platform !== "win32") {
                await chmod(paths.instancesDir, 0o700);
            }
        } catch (error) {
            if (isFileMissingError(error)) return [];
            throw createError({
                code: errorCodes.controlConfigLoadFailed,
                cause: error,
                details: { configFile: paths.instancesDir, phase: "read" },
                message: `Failed to load instance configs from ${paths.instancesDir}.`,
                retryable: false
            });
        }

        const instances: ControlInstanceConfig[] = [];
        for (const fileName of entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right))) {
            const filePath = join(paths.instancesDir, fileName);
            try {
                const source = await readFile(filePath, "utf8");
                await secureFile(filePath);
                const draft = this.#instanceDocument.decode(this.#tomlCodec.decode(source));
                instances.push(normalizeConfigInstanceDraft(draft));
            } catch (error) {
                throw attachConfigFile(error, filePath);
            }
        }
        return instances;
    }

    async #removeStaleInstances(paths: ControlPathHome, activeFiles: ReadonlySet<string>): Promise<void> {
        for (const entry of await readdir(paths.instancesDir, { encoding: "utf8", withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
            const filePath = join(paths.instancesDir, entry.name);
            if (!activeFiles.has(filePath)) await rm(filePath, { force: true });
        }
    }
}

async function atomicWriteFile(filePath: string, source: string): Promise<void> {
    const directory = dirname(filePath);
    await secureDirectory(directory);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
        await file.writeFile(source, "utf8");
        await file.sync();
        await file.close();
        await rename(temporaryPath, filePath);
        await secureFile(filePath);
        if (process.platform !== "win32") {
            const directoryHandle = await open(directory, "r");
            try {
                await directoryHandle.sync();
            } finally {
                await directoryHandle.close();
            }
        }
    } catch (error) {
        await file.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw createError({
            code: errorCodes.controlConfigLoadFailed,
            cause: error,
            details: { configFile: filePath, phase: "write" },
            message: `Failed to write control config to ${filePath}.`,
            retryable: false
        });
    }
}

async function secureDirectory(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700, recursive: true });
    if (process.platform !== "win32") {
        await chmod(path, 0o700);
    }
}

async function secureFile(path: string): Promise<void> {
    if (process.platform !== "win32") {
        await chmod(path, 0o600);
    }
}

function attachConfigFile(error: unknown, configFile: string): Error {
    if (error instanceof ConfigInputError) {
        return createError({
            code:
                error.issue.phase === "semantic"
                    ? errorCodes.controlConfigValidationFailed
                    : errorCodes.controlConfigParseFailed,
            cause: error,
            details: {
                configFile,
                fieldPath: formatConfigPath(error.issue.path),
                issueCode: error.issue.code,
                phase: error.issue.phase
            },
            message: error.message,
            retryable: false
        });
    }
    if (isStructuredConfigError(error)) {
        return createError({
            code: error.code,
            cause: error,
            details: { configFile, ...(error.details ?? {}) },
            message: error.message,
            retryable: false
        });
    }
    return createError({
        code: errorCodes.controlConfigLoadFailed,
        cause: error,
        details: { configFile, phase: "read" },
        message: `Failed to load control config from ${configFile}.`,
        retryable: false
    });
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isStructuredConfigError(
    error: unknown
): error is { code: string; details?: Record<string, unknown>; message: string } {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        "message" in error &&
        typeof error.message === "string"
    );
}
