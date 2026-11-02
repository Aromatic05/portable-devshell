import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
    ExtensionContext,
    ExtensionJsonValue,
    ExtensionLogger,
    ExtensionManifest,
} from "@portable-devshell/extension";

import {
    ExtensionCapabilityAssembler,
    type ExtensionCapabilityAssemblerOptions,
    type ExtensionCapabilitySet,
} from "../api/cap/index.js";
import type { ExtensionGeneration } from "../registration/Generation.js";
import type { ExtensionPointRegistry } from "../registration/PointRegistry.js";
import { ExtensionRegistrationBuilder } from "../registration/Registration.js";
import { ExtensionPathLayout } from "../state/Layout.js";
import {
    ExtensionGenerationActivator,
    type ExtensionGenerationActivatorOptions,
} from "./Activation.js";
import { readExtensionManifest } from "./Manifest.js";
import {
    assertPlainDirectory,
    assertPlainFile,
    resolveContainedPath,
} from "./Paths.js";

export interface ExtensionLoaderOptions
    extends ExtensionCapabilityAssemblerOptions,
        ExtensionGenerationActivatorOptions {
    loggerFactory?: (id: string, generation: string) => ExtensionLogger;
    paths: ExtensionPathLayout;
}

export class ExtensionLoader {
    readonly #activator: ExtensionGenerationActivator;
    readonly #capabilities: ExtensionCapabilityAssembler;
    readonly #loggerFactory: (
        id: string,
        generation: string,
    ) => ExtensionLogger;
    readonly #paths: ExtensionPathLayout;
    readonly points: ExtensionPointRegistry;
    readonly #runtimeRoots = new Map<string, Promise<void>>();

    constructor(options: ExtensionLoaderOptions) {
        this.#activator = new ExtensionGenerationActivator(options);
        this.#capabilities = new ExtensionCapabilityAssembler(options);
        this.#loggerFactory =
            options.loggerFactory ??
            ((id, generation) => consoleExtensionLogger(id, generation));
        this.#paths = options.paths;
        this.points = options.points;
    }

    async load(id: string, generation: string): Promise<ExtensionGeneration> {
        const manifest = await this.readManifest(id, generation);
        const codeDirectory = this.#paths.generationDirectory(id, generation);
        const dataDirectory = this.#paths.dataDirectory(id);
        const runtimeRoot = this.#paths.runtimeDirectory(id, generation);
        const stateDirectory = this.#paths.stateDirectory(id);
        const entryPath = resolveContainedPath(
            codeDirectory,
            manifest.entry,
            "Extension entry",
        );
        await assertPlainFile(entryPath, `Extension entry for ${id}`);
        const logger = this.#loggerFactory(id, generation);
        const registrations = new ExtensionRegistrationBuilder(
            manifest,
            codeDirectory,
            this.points,
        );
        const register: ExtensionContext["register"] = (
            point,
            localId,
            binding,
        ) => {
            registrations.register(point, localId, binding);
        };
        await this.#prepareRuntimeRoot(runtimeRoot);
        await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
        await assertPlainDirectory(
            runtimeRoot,
            `Extension runtime generation root for ${id}`,
        );
        await mkdir(dataDirectory, { mode: 0o700, recursive: true });
        await mkdir(stateDirectory, { mode: 0o700, recursive: true });
        const runtimeDirectory = join(runtimeRoot, `run-${randomUUID()}`);
        await mkdir(runtimeDirectory, { mode: 0o700 });
        let capabilities: ExtensionCapabilitySet;
        try {
            capabilities = await this.#capabilities.assemble({
                dataDirectory,
                extensionId: id,
                generation,
                manifest,
                stateDirectory,
            });
        } catch (error) {
            try {
                await rm(runtimeDirectory, { force: true, recursive: true });
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "Extension preparation cleanup failed.");
            }
            throw error;
        }
        const context: ExtensionContext = Object.freeze({
            capabilities: capabilities.contextCapabilities,
            ...(capabilities.config?.owned === undefined
                ? {}
                : { config: capabilities.config.owned }),
            generation,
            id,
            logger,
            paths: Object.freeze({
                codeDirectory,
                dataDirectory,
                runtimeDirectory,
                stateDirectory,
            }),
            register,
            version: manifest.version,
        });

        return await this.#activator.activate({
            capabilities,
            codeDirectory,
            context,
            entryPath,
            generation,
            id,
            logger,
            manifest,
            registrations,
            runtimeDirectory,
        });
    }

    async readManifest(
        id: string,
        generation: string,
    ): Promise<ExtensionManifest> {
        return await readExtensionManifest(this.#paths, id, generation);
    }

    async #prepareRuntimeRoot(runtimeRoot: string): Promise<void> {
        let preparation = this.#runtimeRoots.get(runtimeRoot);
        if (preparation === undefined) {
            preparation = (async () => {
                await rm(runtimeRoot, { force: true, recursive: true });
                await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
                await assertPlainDirectory(
                    runtimeRoot,
                    "Extension runtime generation root",
                );
            })();
            this.#runtimeRoots.set(runtimeRoot, preparation);
            void preparation.catch(() =>
                this.#runtimeRoots.delete(runtimeRoot),
            );
        }
        await preparation;
    }
}

function consoleExtensionLogger(
    id: string,
    generation: string,
): ExtensionLogger {
    const prefix = `[extension:${id}:${generation}]`;
    const write = (
        method: "debug" | "error" | "info" | "warn",
        message: string,
        details?: ExtensionJsonValue,
    ) => {
        if (details === undefined) console[method](`${prefix} ${message}`);
        else console[method](`${prefix} ${message}`, details);
    };
    return {
        debug: (message, details) => write("debug", message, details),
        error: (message, details) => write("error", message, details),
        info: (message, details) => write("info", message, details),
        warn: (message, details) => write("warn", message, details),
    };
}
