import { readFile } from "node:fs/promises";

import { parseExtensionManifest } from "@portable-devshell/extension";

import { ControlConfigStore } from "../control/config/storage/Store.js";
import { ExtensionHostModuleResolver } from "../control/extension/generation/discovery/ModuleResolver.js";
import { ExtensionPathLayout } from "../control/extension/state/Layout.js";
import { ExtensionRegistryStore } from "../control/extension/state/Store.js";

export interface ControlMigrationResult {
    changed: boolean;
    domains: readonly string[];
}

export interface ControlMigrationOptions {
    homeDirectory?: string;
}

export interface ControlUpdatePreflightOptions extends ControlMigrationOptions {
    environment?: NodeJS.ProcessEnv;
}

export interface ControlUpdatePreflightResult {
    extensions: {
        checkedGenerations: number;
    };
    migration: {
        domains: readonly string[];
        required: boolean;
    };
}

export async function migrateControlState(
    options: ControlMigrationOptions = {},
): Promise<ControlMigrationResult> {
    const config = await new ControlConfigStore().migrate(options.homeDirectory);
    return {
        changed: config.changed,
        domains: config.changed ? ["config"] : [],
    };
}

export async function preflightControlUpdate(
    options: ControlUpdatePreflightOptions = {},
): Promise<ControlUpdatePreflightResult> {
    const config = await new ControlConfigStore().inspectMigration(
        options.homeDirectory,
    );
    const paths = new ExtensionPathLayout({
        environment: options.environment,
        homeDirectory: options.homeDirectory,
    });
    const registry = await new ExtensionRegistryStore(paths.registryFile).read();
    const resolver = new ExtensionHostModuleResolver(import.meta.url);
    let checkedGenerations = 0;
    try {
        for (const [id, entry] of Object.entries(registry.extensions)) {
            const generations = new Set(
                [entry.selectedGeneration, entry.lastKnownGoodGeneration].filter(
                    (value): value is string => value !== undefined,
                ),
            );
            for (const generation of generations) {
                const manifest = parseExtensionManifest(
                    JSON.parse(
                        await readFile(paths.manifestFile(id, generation), "utf8"),
                    ) as unknown,
                );
                if (manifest.id !== id) {
                    throw new Error(
                        `Extension generation ${generation} declares id ${manifest.id}, expected ${id}.`,
                    );
                }
                const lease = resolver.register(
                    paths.generationDirectory(id, generation),
                    manifest.hostDependencies,
                );
                lease.release();
                checkedGenerations += 1;
            }
        }
    } finally {
        resolver.dispose();
    }
    return {
        extensions: { checkedGenerations },
        migration: {
            domains: config.changed ? ["config"] : [],
            required: config.changed,
        },
    };
}
