import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
    ConfigInputError,
    ControlPathHome,
    createDefaultControlConfig,
    createError,
    errorCodes,
    formatConfigPath,
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    type ConfigInstanceDraft,
    type ConfigMcpAuthDraft,
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
        await recoverConfigTransaction(paths);
        let globalConfig: ControlGlobalConfig | undefined;
        let legacyMcpAuth: ConfigMcpAuthDraft | undefined;

        try {
            const source = await readFile(paths.configFile, "utf8");
            await secureFile(paths.configFile);
            const draft = this.#globalDocument.decode(this.#tomlCodec.decode(source));
            legacyMcpAuth = (draft as ConfigGlobalDraftWithLegacyAuth).legacyMcpAuth;
            globalConfig = normalizeConfigGlobalDraft(draft);
        } catch (error) {
            if (!isFileMissingError(error)) throw attachConfigFile(error, paths.configFile);
        }

        if (globalConfig === undefined) {
            const config = this.#validator.validate(createDefaultControlConfig());
            await this.write(config, homeDirectory);
            return config;
        }

        const loadedInstances = await this.#readInstances(paths, legacyMcpAuth);
        const config = this.#validator.validate({
            ...globalConfig,
            instances: loadedInstances.instances
        });
        if (legacyMcpAuth !== undefined || loadedInstances.migrated) await this.write(config, homeDirectory);
        return config;
    }

    async write(config: ControlConfig, homeDirectory?: string): Promise<void> {
        const paths = new ControlPathHome(homeDirectory);
        await recoverConfigTransaction(paths);
        const validated = this.#validator.validate(config);
        const globalSource = this.#tomlCodec.encode(this.#globalDocument.encode(validated));
        const instanceSources = validated.instances.map((instance) => ({
            fileName: basename(paths.instanceConfigFile(instance.name)),
            filePath: paths.instanceConfigFile(instance.name),
            source: this.#tomlCodec.encode(this.#instanceDocument.encode(instance))
        }));

        await secureDirectory(paths.controlHomeDir);
        await secureDirectory(paths.instancesDir);
        const transaction = await prepareConfigTransaction(
            paths,
            instanceSources.map((entry) => entry.fileName)
        );
        try {
            await atomicWriteFile(paths.configFile, globalSource);
            for (const entry of instanceSources) await atomicWriteFile(entry.filePath, entry.source);
            await this.#removeStaleInstances(paths, new Set(instanceSources.map((entry) => entry.filePath)));
            await commitConfigTransaction(transaction);
        } catch (error) {
            try {
                await rollbackConfigTransaction(paths, transaction);
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    "Control configuration write failed and the previous generation could not be restored."
                );
            }
            throw error;
        }
    }

    async #readInstances(
        paths: ControlPathHome,
        legacyMcpAuth?: ConfigMcpAuthDraft
    ): Promise<{ instances: ControlInstanceConfig[]; migrated: boolean }> {
        let entries: Array<{ isFile(): boolean; name: string }>;
        try {
            entries = await readdir(paths.instancesDir, { encoding: "utf8", withFileTypes: true });
            if (process.platform !== "win32") {
                await chmod(paths.instancesDir, 0o700);
            }
        } catch (error) {
            if (isFileMissingError(error)) return { instances: [], migrated: false };
            throw createError({
                code: errorCodes.controlConfigLoadFailed,
                cause: error,
                details: { configFile: paths.instancesDir, phase: "read" },
                message: `Failed to load instance configs from ${paths.instancesDir}.`,
                retryable: false
            });
        }

        const instances: ControlInstanceConfig[] = [];
        let migrated = false;
        for (const fileName of entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right))) {
            const filePath = join(paths.instancesDir, fileName);
            try {
                const source = await readFile(filePath, "utf8");
                await secureFile(filePath);
                const draft = this.#instanceDocument.decode(this.#tomlCodec.decode(source)) as ConfigInstanceDraftWithMigration;
                const normalized = normalizeConfigInstanceDraft({
                    ...draft,
                    mcp: draft.mcp?.enabled === false || legacyMcpAuth === undefined
                        ? draft.mcp
                        : { ...draft.mcp, ...toLegacyInstanceAuth(legacyMcpAuth) }
                });
                migrated ||= draft.migratedFromVersion === 2 || mcpGroupsChanged(draft, normalized);
                instances.push(normalized);
            } catch (error) {
                throw attachConfigFile(error, filePath);
            }
        }
        return { instances, migrated };
    }

    async #removeStaleInstances(paths: ControlPathHome, activeFiles: ReadonlySet<string>): Promise<void> {
        for (const entry of await readdir(paths.instancesDir, { encoding: "utf8", withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
            const filePath = join(paths.instancesDir, entry.name);
            if (!activeFiles.has(filePath)) await rm(filePath, { force: true });
        }
    }
}


type ConfigInstanceDraftWithMigration = ConfigInstanceDraft & {
    migratedFromVersion?: 2;
};

function mcpGroupsChanged(draft: ConfigInstanceDraft, normalized: ControlInstanceConfig): boolean {
    const configured = draft.mcp?.tools?.groups;
    if (configured === undefined) return false;
    const canonical = normalized.mcp.tools.groups;
    return configured.length !== canonical.length || configured.some((group, index) => group !== canonical[index]);
}

interface ConfigTransactionManifest {
    existingGlobal: boolean;
    existingInstances: string[];
    nextInstances: string[];
}

interface PreparedConfigTransaction {
    directory: string;
    manifest: ConfigTransactionManifest;
    markerFile: string;
}

async function prepareConfigTransaction(
    paths: ControlPathHome,
    nextInstances: string[]
): Promise<PreparedConfigTransaction> {
    const id = randomUUID();
    const directory = join(paths.controlHomeDir, `.config-transaction-${id}`);
    const markerFile = join(paths.controlHomeDir, ".config-transaction");
    const backupDirectory = join(directory, "backup");
    const backupInstancesDirectory = join(backupDirectory, "instances");
    await secureDirectory(backupInstancesDirectory);

    const globalSource = await readOptionalFile(paths.configFile);
    if (globalSource !== undefined) {
        await atomicWriteFile(join(backupDirectory, "config.toml"), globalSource);
    }
    const existingInstances = await listInstanceConfigFiles(paths.instancesDir);
    for (const fileName of existingInstances) {
        const source = await readFile(join(paths.instancesDir, fileName), "utf8");
        await atomicWriteFile(join(backupInstancesDirectory, fileName), source);
    }

    const manifest: ConfigTransactionManifest = {
        existingGlobal: globalSource !== undefined,
        existingInstances,
        nextInstances: [...nextInstances]
    };
    await atomicWriteFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await atomicWriteFile(markerFile, id);
    return { directory, manifest, markerFile };
}

async function recoverConfigTransaction(paths: ControlPathHome): Promise<void> {
    const markerFile = join(paths.controlHomeDir, ".config-transaction");
    const marker = await readOptionalFile(markerFile);
    if (marker === undefined) {
        return;
    }
    const id = marker.trim();
    if (!/^[0-9a-f-]{36}$/u.test(id)) {
        throw createError({
            code: errorCodes.controlConfigLoadFailed,
            details: { configFile: markerFile, phase: "recover" },
            message: "Control configuration transaction marker is invalid.",
            retryable: false
        });
    }
    const directory = join(paths.controlHomeDir, `.config-transaction-${id}`);
    let manifest: ConfigTransactionManifest;
    try {
        manifest = parseConfigTransactionManifest(
            JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown
        );
    } catch (error) {
        throw createError({
            code: errorCodes.controlConfigLoadFailed,
            cause: error,
            details: { configFile: markerFile, phase: "recover" },
            message: "Failed to recover the previous control configuration generation.",
            retryable: false
        });
    }
    await rollbackConfigTransaction(paths, { directory, manifest, markerFile });
}

async function rollbackConfigTransaction(
    paths: ControlPathHome,
    transaction: PreparedConfigTransaction
): Promise<void> {
    const backupDirectory = join(transaction.directory, "backup");
    if (transaction.manifest.existingGlobal) {
        await atomicWriteFile(
            paths.configFile,
            await readFile(join(backupDirectory, "config.toml"), "utf8")
        );
    } else {
        await removeFileIfPresent(paths.configFile);
    }

    const allInstances = new Set([
        ...transaction.manifest.existingInstances,
        ...transaction.manifest.nextInstances
    ]);
    for (const fileName of allInstances) {
        const target = join(paths.instancesDir, fileName);
        if (transaction.manifest.existingInstances.includes(fileName)) {
            await atomicWriteFile(
                target,
                await readFile(join(backupDirectory, "instances", fileName), "utf8")
            );
        } else {
            await removeFileIfPresent(target);
        }
    }
    await rm(transaction.markerFile, { force: true });
    await syncDirectory(paths.controlHomeDir);
    await rm(transaction.directory, { force: true, recursive: true });
}

async function commitConfigTransaction(transaction: PreparedConfigTransaction): Promise<void> {
    await rm(transaction.markerFile, { force: true });
    await syncDirectory(dirname(transaction.markerFile));
    await rm(transaction.directory, { force: true, recursive: true });
}

function parseConfigTransactionManifest(value: unknown): ConfigTransactionManifest {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Configuration transaction manifest must be an object.");
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.existingGlobal !== "boolean" ||
        !isSafeInstanceFileList(record.existingInstances) ||
        !isSafeInstanceFileList(record.nextInstances)
    ) {
        throw new Error("Configuration transaction manifest is invalid.");
    }
    return {
        existingGlobal: record.existingGlobal,
        existingInstances: record.existingInstances,
        nextInstances: record.nextInstances
    };
}

function isSafeInstanceFileList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) =>
        typeof entry === "string" &&
        /^[A-Za-z0-9-]+\.toml$/u.test(entry) &&
        !entry.startsWith("-")
    );
}

async function listInstanceConfigFiles(directory: string): Promise<string[]> {
    try {
        return (await readdir(directory, { encoding: "utf8", withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right));
    } catch (error) {
        if (isFileMissingError(error)) {
            return [];
        }
        throw error;
    }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, "utf8");
    } catch (error) {
        if (isFileMissingError(error)) {
            return undefined;
        }
        throw error;
    }
}

async function removeFileIfPresent(filePath: string): Promise<void> {
    try {
        const entry = await lstat(filePath);
        if (entry.isFile()) {
            await rm(filePath, { force: true });
        }
    } catch (error) {
        if (!isFileMissingError(error)) {
            throw error;
        }
    }
}

async function syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") {
        return;
    }
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

interface ConfigGlobalDraftWithLegacyAuth {
    legacyMcpAuth?: ConfigMcpAuthDraft;
}

function toLegacyInstanceAuth(auth: ConfigMcpAuthDraft) {
    if (auth.mode === "none") return { auth: "none" as const };
    if (auth.mode === "token") return { auth: "token" as const, token: auth.token };
    return { auth: "oauth2" as const, oauth2: auth.oauth2 };
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
