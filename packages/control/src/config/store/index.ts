import { randomUUID } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
    ConfigInputError,
    ControlPathHome,
    createDefaultControlConfig,
    createRemoteError,
    controlErrorCodes,
    formatConfigPath,
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    type ControlConfig,
    type ControlGlobalConfig,
    type ControlInstanceConfig,
} from "@portable-devshell/shared";

import { ControlConfigValidator } from "../engine/Validator.js";
import {
    ControlGlobalTomlDocument,
} from "./document/Global.js";
import { ControlInstanceTomlDocument } from "./document/Instance.js";
import { ControlConfigTomlCodec } from "./TomlCodec.js";
import type { ConfigRegistry } from "../domain/Registry.js";

export interface ControlConfigStoreOptions {
    globalDocument?: ControlGlobalTomlDocument;
    instanceDocument?: ControlInstanceTomlDocument;
    registry?: ConfigRegistry;
    tomlCodec?: ControlConfigTomlCodec;
    validator?: ControlConfigValidator;
}

export interface ControlConfigMigrationResult {
    changed: boolean;
}

/** Configuration has committed; only removal of the superseded backup failed. */
export class ControlConfigCommittedCleanupError extends AggregateError {
    constructor(error: unknown) {
        super(
            [error],
            "Control configuration was committed, but the obsolete transaction backup could not be removed.",
        );
        this.name = "ControlConfigCommittedCleanupError";
    }
}

export class ControlConfigStore {
    readonly #globalDocument: ControlGlobalTomlDocument;
    readonly #instanceDocument: ControlInstanceTomlDocument;
    readonly #tomlCodec: ControlConfigTomlCodec;
    readonly #validator: ControlConfigValidator;

    constructor(options: ControlConfigStoreOptions = {}) {
        this.#globalDocument =
            options.globalDocument ??
            new ControlGlobalTomlDocument(options.registry);
        this.#instanceDocument =
            options.instanceDocument ?? new ControlInstanceTomlDocument();
        this.#tomlCodec = options.tomlCodec ?? new ControlConfigTomlCodec();
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    async readOrCreate(homeDirectory?: string): Promise<ControlConfig> {
        const config = await this.#read(homeDirectory);
        if (config !== undefined) return config;

        // The global document may have been lost while Instance files survived.
        // Recover usable Instances on the first load, without rewriting their
        // original documents or pruning any files that we could not parse.
        const defaults = createDefaultControlConfig();
        const instances = await this.#readInstances(new ControlPathHome(homeDirectory), defaults, true);
        defaults.instances = instances;
        if (instances.some((instance) => instance.provider === "reverse")) {
            defaults.mcp.enabled = true;
            console.warn("Restoring reverse Instances with default MCP listener settings; review the public endpoint.");
        }
        const created = this.#validator.validate(defaults);
        await this.#write(created, homeDirectory, false);
        return created;
    }

    async migrate(
        homeDirectory?: string,
    ): Promise<ControlConfigMigrationResult> {
        await this.#read(homeDirectory);
        return { changed: false };
    }

    async inspectMigration(
        homeDirectory?: string,
    ): Promise<ControlConfigMigrationResult> {
        await this.#read(homeDirectory);
        return { changed: false };
    }

    async #read(homeDirectory?: string): Promise<ControlConfig | undefined> {
        const paths = new ControlPathHome(homeDirectory);
        await recoverConfigTransaction(paths);
        let globalConfig: ControlGlobalConfig | undefined;

        try {
            const source = await readFile(paths.configFile, "utf8");
            await secureFile(paths.configFile);
            globalConfig = normalizeConfigGlobalDraft(
                this.#globalDocument.decode(this.#tomlCodec.decode(source)),
            );
        } catch (error) {
            if (!isFileMissingError(error))
                throw attachConfigFile(error, paths.configFile);
        }

        if (globalConfig === undefined) return undefined;

        const instances = await this.#readInstances(paths, globalConfig);
        return this.#validator.validate({ ...globalConfig, instances });
    }

    async write(config: ControlConfig, homeDirectory?: string): Promise<void> {
        await this.#write(config, homeDirectory, true);
    }

    async #write(
        config: ControlConfig,
        homeDirectory: string | undefined,
        pruneStale: boolean,
    ): Promise<void> {
        const paths = new ControlPathHome(homeDirectory);
        await recoverConfigTransaction(paths);
        // Collect previously committed backups on a later write, not during
        // reads or while an uncommitted transaction marker still exists.
        await cleanupCommittedConfigBackups(paths).catch((error) => {
            console.warn("Control configuration backup cleanup deferred:", error);
        });
        const validated = this.#validator.validate(config);
        const globalSource = this.#tomlCodec.encode(
            this.#globalDocument.encode(validated),
        );
        const instanceSources = validated.instances.map((instance) => ({
            fileName: basename(paths.instanceConfigFile(instance.name)),
            filePath: paths.instanceConfigFile(instance.name),
            source: this.#tomlCodec.encode(
                this.#instanceDocument.encode(instance),
            ),
        }));

        await secureDirectory(paths.controlHomeDir);
        await secureDirectory(paths.instancesDir);
        const transaction = await prepareConfigTransaction(
            paths,
            instanceSources.map((entry) => entry.fileName),
        );
        try {
            await atomicWriteFile(paths.configFile, globalSource);
            // On first global-config creation, recovered Instance documents
            // are existing user data, not files to normalize or overwrite.
            if (pruneStale)
                for (const entry of instanceSources)
                    await atomicWriteFile(entry.filePath, entry.source);
            if (pruneStale)
                await this.#removeStaleInstances(
                    paths,
                    new Set(instanceSources.map((entry) => entry.filePath)),
                    validated,
                );
        } catch (error) {
            try {
                await rollbackConfigTransaction(paths, transaction);
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    "Control configuration write failed and the previous generation could not be restored.",
                );
            }
            throw error;
        }
        // The commit marker is the recovery boundary. Once removal begins,
        // recovery may observe the new generation; never attempt a rollback
        // after this point, including when the directory fsync fails.
        try {
            await commitConfigTransaction(transaction);
        } catch (error) {
            throw new AggregateError(
                [error],
                "Control configuration commit could not be finalized; recovery will resolve any remaining transaction marker.",
            );
        }
        // Backups are garbage after the marker has been durably removed.
        // A partial recursive deletion must never turn into a rollback.
        try {
            await rm(transaction.directory, { force: true, recursive: true });
        } catch (error) {
            throw new ControlConfigCommittedCleanupError(error);
        }
    }

    async #readInstances(
        paths: ControlPathHome,
        globalConfig: ControlGlobalConfig,
        restoringGlobal = false,
    ): Promise<ControlInstanceConfig[]> {
        let entries: Array<{ isFile(): boolean; name: string }>;
        try {
            entries = await readdir(paths.instancesDir, {
                encoding: "utf8",
                withFileTypes: true,
            });
            if (process.platform !== "win32") {
                await chmod(paths.instancesDir, 0o700);
            }
        } catch (error) {
            if (isFileMissingError(error))
                return [];
            throw createRemoteError({
                code: controlErrorCodes.configLoadFailed,
                cause: error,
                details: { configFile: paths.instancesDir, phase: "read" },
                message: `Failed to load instance configs from ${paths.instancesDir}.`,
                retryable: false,
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
                const draft = this.#instanceDocument.decode(
                    this.#tomlCodec.decode(source),
                );
                const instance = normalizeConfigInstanceDraft(draft);
                const effectiveGlobal = restoringGlobal && instance.provider === "reverse"
                    ? { ...globalConfig, mcp: { ...globalConfig.mcp, enabled: true } }
                    : globalConfig;
                this.#validator.validate({ ...effectiveGlobal, instances: [instance] });
                if (instances.some((existing) => existing.name === instance.name))
                    throw new Error("Duplicate Instance name " + instance.name + ".");
                instances.push(instance);
            } catch (error) {
                // A broken instance file cannot disable unrelated Instances.
                // Preserve it on subsequent config writes for manual recovery.
                console.warn("Instance configuration skipped:", attachConfigFile(error, filePath));
            }
        }
        return instances;
    }

    async #removeStaleInstances(
        paths: ControlPathHome,
        activeFiles: ReadonlySet<string>,
        globalConfig: ControlGlobalConfig,
    ): Promise<void> {
        for (const entry of await readdir(paths.instancesDir, {
            encoding: "utf8",
            withFileTypes: true,
        })) {
            if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
            const filePath = join(paths.instancesDir, entry.name);
            if (activeFiles.has(filePath)) continue;
            try {
                const source = await readFile(filePath, "utf8");
                const instance = normalizeConfigInstanceDraft(
                    this.#instanceDocument.decode(this.#tomlCodec.decode(source)),
                );
                this.#validator.validate({ ...globalConfig, instances: [instance] });
                // Stale removal only applies to a known, valid Instance document
                // at its canonical path; never delete unrecognized user files.
                if (basename(paths.instanceConfigFile(instance.name)) !== entry.name)
                    continue;
            } catch (error) {
                console.warn("Preserving unreadable Instance configuration:", attachConfigFile(error, filePath));
                continue;
            }
            await rm(filePath, { force: true });
        }
    }
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
    nextInstances: string[],
): Promise<PreparedConfigTransaction> {
    const id = randomUUID();
    const directory = join(paths.controlHomeDir, `.config-transaction-${id}`);
    const markerFile = join(paths.controlHomeDir, ".config-transaction");
    const backupDirectory = join(directory, "backup");
    const backupInstancesDirectory = join(backupDirectory, "instances");
    await secureDirectory(backupInstancesDirectory);

    const globalSource = await readOptionalFile(paths.configFile);
    if (globalSource !== undefined) {
        await atomicWriteFile(
            join(backupDirectory, "config.toml"),
            globalSource,
        );
    }
    const existingInstances = await listInstanceConfigFiles(paths.instancesDir);
    for (const fileName of existingInstances) {
        const source = await readFile(
            join(paths.instancesDir, fileName),
            "utf8",
        );
        await atomicWriteFile(join(backupInstancesDirectory, fileName), source);
    }

    const manifest: ConfigTransactionManifest = {
        existingGlobal: globalSource !== undefined,
        existingInstances,
        nextInstances: [...nextInstances],
    };
    await atomicWriteFile(
        join(directory, "manifest.json"),
        JSON.stringify(manifest),
    );
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
        throw createRemoteError({
            code: controlErrorCodes.configLoadFailed,
            details: { configFile: markerFile, phase: "recover" },
            message: "Control configuration transaction marker is invalid.",
            retryable: false,
        });
    }
    const directory = join(paths.controlHomeDir, `.config-transaction-${id}`);
    let manifest: ConfigTransactionManifest;
    try {
        manifest = parseConfigTransactionManifest(
            JSON.parse(
                await readFile(join(directory, "manifest.json"), "utf8"),
            ) as unknown,
        );
    } catch (error) {
        throw createRemoteError({
            code: controlErrorCodes.configLoadFailed,
            cause: error,
            details: { configFile: markerFile, phase: "recover" },
            message:
                "Failed to recover the previous control configuration generation.",
            retryable: false,
        });
    }
    await rollbackConfigTransaction(paths, { directory, manifest, markerFile });
}

async function rollbackConfigTransaction(
    paths: ControlPathHome,
    transaction: PreparedConfigTransaction,
): Promise<void> {
    const backupDirectory = join(transaction.directory, "backup");
    if (transaction.manifest.existingGlobal) {
        await atomicWriteFile(
            paths.configFile,
            await readFile(join(backupDirectory, "config.toml"), "utf8"),
        );
    } else {
        await removeFileIfPresent(paths.configFile);
    }

    const allInstances = new Set([
        ...transaction.manifest.existingInstances,
        ...transaction.manifest.nextInstances,
    ]);
    for (const fileName of allInstances) {
        const target = join(paths.instancesDir, fileName);
        if (transaction.manifest.existingInstances.includes(fileName)) {
            await atomicWriteFile(
                target,
                await readFile(
                    join(backupDirectory, "instances", fileName),
                    "utf8",
                ),
            );
        } else {
            await removeFileIfPresent(target);
        }
    }
    await rm(transaction.markerFile, { force: true });
    await syncDirectory(paths.controlHomeDir);
    await rm(transaction.directory, { force: true, recursive: true });
}

async function commitConfigTransaction(
    transaction: PreparedConfigTransaction,
): Promise<void> {
    // An orphaned journal is safe to garbage collect only after publication
    // of this durable commit-intent marker and removal of the global marker.
    await atomicWriteFile(join(transaction.directory, "committed"), "");
    await rm(transaction.markerFile, { force: true });
    await syncDirectory(dirname(transaction.markerFile));
}

async function cleanupCommittedConfigBackups(paths: ControlPathHome): Promise<void> {
    if (await readOptionalFile(join(paths.controlHomeDir, ".config-transaction")) !== undefined)
        return;
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
        entries = await readdir(paths.controlHomeDir, { withFileTypes: true });
    } catch (error) {
        if (isFileMissingError(error)) return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() ||
            !/^\.config-transaction-[0-9a-f-]{36}$/u.test(entry.name)) continue;
        const directory = join(paths.controlHomeDir, entry.name);
        if (await readOptionalFile(join(directory, "committed")) === undefined) continue;
        await rm(directory, { recursive: true, force: true });
    }
}

function parseConfigTransactionManifest(
    value: unknown,
): ConfigTransactionManifest {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
            "Configuration transaction manifest must be an object.",
        );
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
        nextInstances: record.nextInstances,
    };
}

function isSafeInstanceFileList(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" && isSafeInstanceFileName(entry))
    );
}

function isSafeInstanceFileName(name: string): boolean {
    // These names come from a directory listing, not the configured Instance
    // naming scheme. Preserve foreign TOMLs, including Unicode/underscores,
    // while never allowing manifest entries to escape the Instances directory.
    return /^[^/\\\0]+\.toml$/u.test(name);
}

async function listInstanceConfigFiles(directory: string): Promise<string[]> {
    try {
        return (
            await readdir(directory, { encoding: "utf8", withFileTypes: true })
        )
            .filter((entry) => entry.isFile() && isSafeInstanceFileName(entry.name))
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

async function atomicWriteFile(
    filePath: string,
    source: string,
): Promise<void> {
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
        throw createRemoteError({
            code: controlErrorCodes.configLoadFailed,
            cause: error,
            details: { configFile: filePath, phase: "write" },
            message: `Failed to write control config to ${filePath}.`,
            retryable: false,
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
        return createRemoteError({
            code:
                error.issue.phase === "semantic"
                    ? controlErrorCodes.configValidationFailed
                    : controlErrorCodes.configParseFailed,
            cause: error,
            details: {
                configFile,
                fieldPath: formatConfigPath(error.issue.path),
                issueCode: error.issue.code,
                phase: error.issue.phase,
            },
            message: error.message,
            retryable: false,
        });
    }
    if (isStructuredConfigError(error)) {
        return createRemoteError({
            code: error.code,
            cause: error,
            details: { configFile, ...(error.details ?? {}) },
            message: error.message,
            retryable: false,
        });
    }
    return createRemoteError({
        code: controlErrorCodes.configLoadFailed,
        cause: error,
        details: { configFile, phase: "read" },
        message: `Failed to load control config from ${configFile}.`,
        retryable: false,
    });
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
    );
}

function isStructuredConfigError(error: unknown): error is {
    code: string;
    details?: Record<string, unknown>;
    message: string;
} {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        "message" in error &&
        typeof error.message === "string"
    );
}
