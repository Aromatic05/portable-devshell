import type { ExtensionManifest } from "@portable-devshell/extension";
import type { ExtensionRuntimeRecord } from "@portable-devshell/shared";

import type { ExtensionGeneration } from "../registration/Generation.js";
import type { ExtensionRetiredGenerationRecord } from "../registration/Retirement.js";
import type { ExtensionRegistryEntry } from "../state/Model.js";

export interface ExtensionFailureRecord {
    generation?: string;
    message: string;
}

export function projectExtensionRuntimeRecord(input: {
    active?: ExtensionGeneration;
    catalogManifest?: ExtensionManifest;
    entry: ExtensionRegistryEntry;
    failure?: ExtensionFailureRecord;
    id: string;
    retired: readonly ExtensionRetiredGenerationRecord[];
}): ExtensionRuntimeRecord {
    const manifest = input.active?.manifest ?? input.catalogManifest;
    const activeFailure =
        input.active?.state === "faulted"
            ? {
                  generation: input.active.generation,
                  message:
                      input.active.faultError instanceof Error
                          ? input.active.faultError.message
                          : String(
                                input.active.faultError ??
                                    "Extension sandbox faulted.",
                            ),
              }
            : undefined;
    const failure = activeFailure ?? input.failure;
    return {
        ...(input.active === undefined
            ? {}
            : { activeGeneration: input.active.generation }),
        enabled: input.entry.enabled,
        ...(failure === undefined ? {} : { failure: { ...failure } }),
        id: input.id,
        ...(input.entry.lastKnownGoodGeneration === undefined
            ? {}
            : {
                  lastKnownGoodGeneration:
                      input.entry.lastKnownGoodGeneration,
              }),
        ...(manifest === undefined ? {} : { name: manifest.name }),
        retired: [...input.retired],
        ...(input.entry.selectedGeneration === undefined
            ? {}
            : { selectedGeneration: input.entry.selectedGeneration }),
        state: !input.entry.enabled
            ? "disabled"
            : input.active?.state === "faulted"
              ? "failed"
              : input.active !== undefined
                ? "active"
                : failure !== undefined
                  ? "failed"
                  : "installed",
        ...(manifest === undefined ? {} : { version: manifest.version }),
    };
}
