import type { ExtensionGeneration } from "./Generation.js";

export async function notifyInstanceGenerationRetired(
    active: ReadonlyMap<string, ExtensionGeneration>,
    instance: string,
): Promise<void> {
    const event = { instance };
    const failures: unknown[] = [];
    await Promise.all(
        [...active.entries()].map(async ([id, generation]) => {
            try {
                await generation.instanceGenerationRetired(event);
            } catch (error) {
                failures.push(
                    new Error(
                        `Extension ${id} failed to handle Instance generation retirement for ${event.instance}.`,
                        { cause: error },
                    ),
                );
            }
        }),
    );
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Extensions failed to handle Instance generation retirement for ${event.instance}.`,
        );
    }
}

export async function notifyContextEnvironmentRetired(
    active: ReadonlyMap<string, ExtensionGeneration>,
    input: {
        ctxId: string;
        instance: string;
        reason: "disabled" | "expired";
    },
): Promise<void> {
    const failures: unknown[] = [];
    await Promise.all(
        [...active.entries()].map(async ([id, generation]) => {
            try {
                await generation.contextEnvironmentRetired(input);
            } catch (error) {
                failures.push(
                    new Error(
                        "Extension " +
                            id +
                            " failed to handle retired Context environment " +
                            input.ctxId +
                            ".",
                        { cause: error },
                    ),
                );
            }
        }),
    );
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            "Extensions failed to handle retired Context environment " +
                input.ctxId +
                ".",
        );
    }
}

export async function retireInstanceHostResources(
    active: ReadonlyMap<string, ExtensionGeneration>,
    instance: string,
): Promise<void> {
    const failures: unknown[] = [];
    await Promise.all(
        [...active.entries()].map(async ([id, generation]) => {
            try {
                await generation.retireInstanceHostResources(instance);
            } catch (error) {
                failures.push(
                    new Error(
                        `Extension ${id} failed to retire host-managed resources for instance ${instance}.`,
                        { cause: error },
                    ),
                );
            }
        }),
    );
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Extensions failed to retire host-managed resources for instance ${instance}.`,
        );
    }
}
