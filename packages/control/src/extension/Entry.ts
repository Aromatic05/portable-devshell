import type { ExtensionModule } from "@portable-devshell/extension";

export function readExtensionModule(
    value: unknown,
    id: string,
): ExtensionModule {
    if (!isRecord(value) || typeof value.activate !== "function") {
        throw new TypeError(
            `Extension ${id} entry must export an activate(context) function.`,
        );
    }
    if (
        value.deactivate !== undefined &&
        typeof value.deactivate !== "function"
    ) {
        throw new TypeError(
            `Extension ${id} deactivate export must be a function.`,
        );
    }
    if (
        value.contextEnvironmentRetired !== undefined &&
        typeof value.contextEnvironmentRetired !== "function"
    ) {
        throw new TypeError(
            "Extension " +
                id +
                " contextEnvironmentRetired export must be a function.",
        );
    }
    if (
        value.instanceGenerationRetired !== undefined &&
        typeof value.instanceGenerationRetired !== "function"
    ) {
        throw new TypeError(
            `Extension ${id} instanceGenerationRetired export must be a function.`,
        );
    }
    return {
        activate: value.activate as ExtensionModule["activate"],
        ...(value.deactivate === undefined
            ? {}
            : {
                  deactivate: value.deactivate as NonNullable<
                      ExtensionModule["deactivate"]
                  >,
              }),
        ...(value.contextEnvironmentRetired === undefined
            ? {}
            : {
                  contextEnvironmentRetired:
                      value.contextEnvironmentRetired as NonNullable<
                          ExtensionModule["contextEnvironmentRetired"]
                      >,
              }),
        ...(value.instanceGenerationRetired === undefined
            ? {}
            : {
                  instanceGenerationRetired:
                      value.instanceGenerationRetired as NonNullable<
                          ExtensionModule["instanceGenerationRetired"]
                      >,
              }),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
