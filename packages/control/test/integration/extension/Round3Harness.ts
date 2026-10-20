import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION, type ExtensionManifest } from "@portable-devshell/extension";
import { ExtensionHost } from "../../../src/extension/host/index.ts";
import { ExtensionGeneration } from "../../../src/extension/registration/Generation.ts";
import { ExtensionRegistrationSet } from "../../../src/extension/registration/Registration.ts";
import { createControlExtensionPointRegistry } from "../../../src/extension/registration/Points.ts";
import type { ExtensionContextEnvironmentRetiredEvent } from "@portable-devshell/extension/context";

export function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => { resolve = yes; });
    return { promise, resolve };
}

export function createRound3Host(options: {
    notify?: (runtime: number, instance: string) => Promise<void>;
    cleanup?: (runtime: number, instance: string) => Promise<void>;
    dispose?: (runtime: number) => Promise<void>;
    contextRetired?: (runtime: number, event: ExtensionContextEnvironmentRetiredEvent) => Promise<void>;
} = {}) {
    const manifest: ExtensionManifest = {
        activation: "lazy", apiVersion: EXTENSION_API_VERSION,
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION, capabilities: [],
        entry: "extension.mjs", hostDependencies: {}, id: "matrix", name: "Matrix", version: "1.0.0",
        extensions: { "cli.native-commands": [{ id: "matrix", title: "Matrix" }] },
    };
    const runtimes: ExtensionGeneration[] = [];
    const disposed: number[] = [];
    let snapshot = { schemaVersion: 1, extensions: { matrix: { enabled: true, selectedGeneration: "same-hash" } } };
    const host = new ExtensionHost({
        registry: { read: async () => structuredClone(snapshot), write: async (next) => { snapshot = structuredClone(next) as typeof snapshot; } },
        loader: {
            points: createControlExtensionPointRegistry(),
            readManifest: async () => manifest,
            load: async (_id, hash) => {
                const number = runtimes.length + 1;
                const runtime = new ExtensionGeneration({
                    generation: hash, manifest,
                    dispose: async () => { await options.dispose?.(number); disposed.push(number); },
                    instanceGenerationRetired: async ({ instance }) => { await options.notify?.(number, instance); },
                    contextEnvironmentRetired: async (event) => { await options.contextRetired?.(number, event); },
                    retireInstanceHostResources: async (instance) => { await options.cleanup?.(number, instance); },
                    registrations: new ExtensionRegistrationSet([{ pointId: "cli.native-commands", id: "matrix",
                        declaration: { id: "matrix", title: "Matrix" }, binding: async () => ({ kind: "text", text: String(number) }) }]),
                });
                runtimes.push(runtime);
                return runtime;
            },
        },
    });
    return { host, runtimes, disposed };
}
