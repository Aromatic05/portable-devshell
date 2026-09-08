import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    EXTENSION_API_VERSION,
    parseExtensionManifest,
    type ExtensionActivation,
    type ExtensionContext,
    type ExtensionAssetCapability,
    type ExtensionInstanceRetireEvent,
    type ExtensionJsonValue,
    type ExtensionLogger,
    type ExtensionManifest,
    type ExtensionModule,
    type ExtensionWorkerCapability
} from "@portable-devshell/extension";

import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { ExtensionAssetCapabilityControl } from "./ExtensionAssetCapabilityControl.js";
import { ExtensionGeneration } from "./ExtensionGeneration.js";
import { ExtensionPathLayout } from "./ExtensionPathLayout.js";
import { ExtensionWorkerCapabilityControl } from "./ExtensionWorkerCapabilityControl.js";

export const CORE_EXTENSION_RESERVED_IDS = new Set([
    "approval",
    "artifact",
    "config",
    "context",
    "debug",
    "extension",
    "help",
    "instance",
    "logs",
    "oauth",
    "overview",
    "restart",
    "secret",
    "skill",
    "start",
    "status",
    "stop",
    "todo",
    "tool",
    "tui",
    "version",
    "watch"
]);

export interface ExtensionWorkerRuntime extends ExtensionWorkerCapability {
    closeAll(): Promise<void>;
    retireInstance(instance: string): Promise<void>;
}

export interface ExtensionLoaderOptions {
    assetsFactory?: (input: {
        allowed: boolean;
        dataDirectory: string;
        extensionId: string;
        generation: string;
    }) => ExtensionAssetCapability;
    importer?: (url: string) => Promise<unknown>;
    instances: InstanceRegistry;
    loggerFactory?: (id: string, generation: string) => ExtensionLogger;
    paths: ExtensionPathLayout;
    reservedIds?: ReadonlySet<string>;
    workerFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionWorkerRuntime;
}

export class ExtensionLoader {
    readonly #assetsFactory?: ExtensionLoaderOptions["assetsFactory"];
    readonly #importer: (url: string) => Promise<unknown>;
    readonly #instances: InstanceRegistry;
    readonly #loggerFactory: (id: string, generation: string) => ExtensionLogger;
    readonly #paths: ExtensionPathLayout;
    readonly #reservedIds: ReadonlySet<string>;
    readonly #workerFactory?: ExtensionLoaderOptions["workerFactory"];

    constructor(options: ExtensionLoaderOptions) {
        this.#assetsFactory = options.assetsFactory;
        this.#importer = options.importer ?? (async (url) => await import(url) as unknown);
        this.#instances = options.instances;
        this.#loggerFactory = options.loggerFactory ?? ((id, generation) => consoleExtensionLogger(id, generation));
        this.#paths = options.paths;
        this.#reservedIds = options.reservedIds ?? CORE_EXTENSION_RESERVED_IDS;
        this.#workerFactory = options.workerFactory;
    }

    async load(id: string, generation: string): Promise<ExtensionGeneration> {
        if (this.#reservedIds.has(id)) {
            throw new Error(`Extension id ${id} is reserved by portable-devshell.`);
        }
        const codeDirectory = this.#paths.generationDirectory(id, generation);
        const dataDirectory = this.#paths.dataDirectory(id);
        const runtimeDirectory = this.#paths.runtimeDirectory(id, generation);
        const stateDirectory = this.#paths.stateDirectory(id);
        await assertPlainDirectory(codeDirectory, `Extension generation directory for ${id}`);
        const manifestPath = this.#paths.manifestFile(id, generation);
        await assertPlainFile(manifestPath, `Extension manifest for ${id}`);
        const manifest = parseExtensionManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
        if (manifest.id !== id) {
            throw new Error(`Extension generation ${generation} declares id ${manifest.id}, expected ${id}.`);
        }
        if (manifest.apiVersion !== EXTENSION_API_VERSION) {
            throw new Error(
                `Extension ${id} requires API version ${manifest.apiVersion}, but Control supports ${EXTENSION_API_VERSION}.`
            );
        }
        const entryPath = resolveContainedPath(codeDirectory, manifest.entry, "Extension entry");
        await assertPlainFile(entryPath, `Extension entry for ${id}`);
        await rm(runtimeDirectory, { force: true, recursive: true });
        await Promise.all([
            mkdir(dataDirectory, { mode: 0o700, recursive: true }),
            mkdir(runtimeDirectory, { mode: 0o700, recursive: true }),
            mkdir(stateDirectory, { mode: 0o700, recursive: true })
        ]);

        const assets = this.#assetsFactory?.({
            allowed: manifest.capabilities.includes("assets"),
            dataDirectory,
            extensionId: id,
            generation
        }) ?? new ExtensionAssetCapabilityControl({
            allowed: manifest.capabilities.includes("assets"),
            dataDirectory,
            extensionId: id
        });

        const worker = this.#workerFactory?.({
            allowed: manifest.capabilities.includes("worker"),
            extensionId: id,
            generation
        }) ?? new ExtensionWorkerCapabilityControl({
            allowed: manifest.capabilities.includes("worker"),
            extensionId: id,
            generation,
            instances: this.#instances
        });
        const context: ExtensionContext = Object.freeze({
            assets,
            generation,
            id,
            logger: this.#loggerFactory(id, generation),
            paths: Object.freeze({ codeDirectory, dataDirectory, runtimeDirectory, stateDirectory }),
            version: manifest.version,
            worker
        });

        let rawActivation: unknown;
        let activation: ExtensionActivation | undefined;
        try {
            const module = readExtensionModule(await this.#importer(pathToFileURL(entryPath).href), id);
            rawActivation = await module.activate(context);
            activation = await validateActivation(rawActivation, manifest, codeDirectory);
            const wrapped = wrapActivation(activation, worker);
            return new ExtensionGeneration({
                activation: wrapped,
                dispose: async () => await disposeGeneration(activation!, worker, runtimeDirectory),
                generation,
                manifest
            });
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            const disposable = readDisposableActivation(rawActivation);
            await disposable?.dispose().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
            await worker.closeAll().catch((cleanupError) => cleanupFailures.push(cleanupError));
            await rm(runtimeDirectory, { force: true, recursive: true }).catch((cleanupError) => cleanupFailures.push(cleanupError));
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${id} activation failed and candidate cleanup was incomplete.`
            );
        }
    }
}

function readExtensionModule(value: unknown, id: string): ExtensionModule {
    if (!isRecord(value) || typeof value.activate !== "function") {
        throw new TypeError(`Extension ${id} entry must export an activate(context) function.`);
    }
    return { activate: value.activate as ExtensionModule["activate"] };
}

async function validateActivation(
    value: unknown,
    manifest: ExtensionManifest,
    codeDirectory: string
): Promise<ExtensionActivation> {
    if (!isRecord(value)) throw new TypeError(`Extension ${manifest.id} activation must be an object.`);
    const allowed = new Set(["command", "dispose", "lifecycle", "rpc", "web"]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw new TypeError(`Extension ${manifest.id} activation has unknown field ${unknown[0]}.`);
    }
    if (typeof value.dispose !== "function") {
        throw new TypeError(`Extension ${manifest.id} activation must provide dispose().`);
    }

    const activation: ExtensionActivation = {
        dispose: value.dispose as ExtensionActivation["dispose"]
    };
    if (value.command !== undefined) {
        requireManifestCapability(manifest, "command");
        if (typeof value.command !== "function") throw new TypeError(`Extension ${manifest.id} command must be a function.`);
        activation.command = value.command as ExtensionActivation["command"];
    }
    if (value.rpc !== undefined) {
        requireManifestCapability(manifest, "rpc");
        if (!isRecord(value.rpc)) throw new TypeError(`Extension ${manifest.id} rpc must be an object.`);
        const handlers: Record<string, NonNullable<ExtensionActivation["rpc"]>[string]> = {};
        for (const [operation, handler] of Object.entries(value.rpc)) {
            if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(operation)) {
                throw new TypeError(`Extension ${manifest.id} RPC operation is invalid: ${operation}.`);
            }
            if (typeof handler !== "function") {
                throw new TypeError(`Extension ${manifest.id} RPC operation ${operation} must be a function.`);
            }
            handlers[operation] = handler as NonNullable<ExtensionActivation["rpc"]>[string];
        }
        activation.rpc = Object.freeze(handlers);
    }
    if (value.lifecycle !== undefined) {
        requireManifestCapability(manifest, "instance-lifecycle");
        if (!isRecord(value.lifecycle)) throw new TypeError(`Extension ${manifest.id} lifecycle must be an object.`);
        const lifecycleKeys = Object.keys(value.lifecycle);
        if (lifecycleKeys.some((key) => key !== "onInstanceRetire")) {
            throw new TypeError(`Extension ${manifest.id} lifecycle has unknown field ${lifecycleKeys.find((key) => key !== "onInstanceRetire")}.`);
        }
        if (value.lifecycle.onInstanceRetire !== undefined && typeof value.lifecycle.onInstanceRetire !== "function") {
            throw new TypeError(`Extension ${manifest.id} onInstanceRetire must be a function.`);
        }
        activation.lifecycle = {
            ...(value.lifecycle.onInstanceRetire === undefined
                ? {}
                : { onInstanceRetire: value.lifecycle.onInstanceRetire as NonNullable<ExtensionActivation["lifecycle"]>["onInstanceRetire"] })
        };
    }
    if (value.web !== undefined) {
        requireManifestCapability(manifest, "web");
        activation.web = await validateWebContribution(value.web, manifest.id, codeDirectory);
    }
    return Object.freeze(activation);
}

async function validateWebContribution(
    value: unknown,
    id: string,
    codeDirectory: string
): Promise<NonNullable<ExtensionActivation["web"]>> {
    if (!isRecord(value) || (value.kind !== "static" && value.kind !== "proxy")) {
        throw new TypeError(`Extension ${id} web contribution must be static or proxy.`);
    }
    if (value.kind === "static") {
        if (Object.keys(value).some((key) => key !== "directory" && key !== "kind")) {
            throw new TypeError(`Extension ${id} static web contribution has unknown fields.`);
        }
        if (typeof value.directory !== "string" || value.directory.length === 0) {
            throw new TypeError(`Extension ${id} static web directory must be a non-empty relative path.`);
        }
        const directory = resolveContainedPath(codeDirectory, value.directory, "Extension web directory");
        await assertPlainDirectory(directory, `Extension web directory for ${id}`);
        return Object.freeze({ directory: value.directory, kind: "static" });
    }
    if (Object.keys(value).some((key) => key !== "kind" && key !== "resolveUpstream")) {
        throw new TypeError(`Extension ${id} proxy web contribution has unknown fields.`);
    }
    if (typeof value.resolveUpstream !== "function") {
        throw new TypeError(`Extension ${id} proxy web contribution must provide resolveUpstream().`);
    }
    return Object.freeze({
        kind: "proxy",
        resolveUpstream: value.resolveUpstream as () => URL | Promise<URL | undefined> | undefined
    });
}

function wrapActivation(
    activation: ExtensionActivation,
    worker: ExtensionWorkerRuntime
): ExtensionActivation {
    const onInstanceRetire = activation.lifecycle?.onInstanceRetire;
    return Object.freeze({
        ...activation,
        lifecycle: Object.freeze({
            onInstanceRetire: async (event: ExtensionInstanceRetireEvent) => {
                const failures: unknown[] = [];
                await Promise.resolve(onInstanceRetire?.(event)).catch((error) => failures.push(error));
                await worker.retireInstance(event.instance).catch((error) => failures.push(error));
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(failures, `Extension instance retirement failed for ${event.instance}.`);
                }
            }
        })
    });
}

async function disposeGeneration(
    activation: ExtensionActivation,
    worker: ExtensionWorkerRuntime,
    runtimeDirectory: string
): Promise<void> {
    const failures: unknown[] = [];
    await Promise.resolve(activation.dispose()).catch((error) => failures.push(error));
    await worker.closeAll().catch((error) => failures.push(error));
    await rm(runtimeDirectory, { force: true, recursive: true }).catch((error) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Extension generation cleanup failed.");
}

function readDisposableActivation(value: unknown): { dispose(): Promise<void> } | undefined {
    if (!isRecord(value) || typeof value.dispose !== "function") return undefined;
    return {
        dispose: async () => await Promise.resolve((value.dispose as () => Promise<void> | void)())
    };
}

function requireManifestCapability(manifest: ExtensionManifest, capability: ExtensionManifest["capabilities"][number]): void {
    if (!manifest.capabilities.includes(capability)) {
        throw new TypeError(`Extension ${manifest.id} did not declare capability ${capability}.`);
    }
}

function resolveContainedPath(root: string, candidate: string, label: string): string {
    if (isAbsolute(candidate)) throw new TypeError(`${label} must be relative to the Extension generation.`);
    const resolved = resolve(root, candidate);
    const relativePath = relative(root, resolved);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return resolved;
    throw new TypeError(`${label} must stay inside the Extension generation.`);
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError(`${label} must be a real directory, not a symlink.`);
    }
}

async function assertPlainFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new TypeError(`${label} must be a regular file, not a symlink.`);
    }
}

function consoleExtensionLogger(id: string, generation: string): ExtensionLogger {
    const prefix = `[extension:${id}:${generation}]`;
    const write = (method: "debug" | "error" | "info" | "warn", message: string, details?: ExtensionJsonValue) => {
        if (details === undefined) console[method](`${prefix} ${message}`);
        else console[method](`${prefix} ${message}`, details);
    };
    return {
        debug: (message, details) => write("debug", message, details),
        error: (message, details) => write("error", message, details),
        info: (message, details) => write("info", message, details),
        warn: (message, details) => write("warn", message, details)
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
