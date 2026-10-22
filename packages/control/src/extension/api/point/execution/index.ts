import type { ControlExecutionConfig } from "@portable-devshell/shared";
import {
    environment,
    sandbox,
    type ExecutionDriverDescriptor,
} from "@portable-devshell/extension/execution";

import type { ExtensionRuntime } from "../../../Api.js";

type ExecutionSelection = NonNullable<ControlExecutionConfig["environment"]>[number];
type CompiledSelection = ExecutionSelection & { driver?: ExecutionDriverDescriptor };

/** Compiles the selected Extension generation's driver descriptions into a
 * Worker-start snapshot. Environment values and cwd evaluation stay on the
 * target Worker; Control receives only executable metadata and configuration.
 */
export async function resolveExecutionDrivers(
    extensions: Pick<ExtensionRuntime, "acquireRegistration" | "listDeclarations">,
    config: ControlExecutionConfig = {},
): Promise<ControlExecutionConfig> {
    const environmentSelections: CompiledSelection[] = [];
    for (const hook of config.environment ?? []) {
        // variables is a core primitive. All external providers must resolve
        // through an installed and enabled Extension generation.
        if (hook.name === "variables") {
            environmentSelections.push(hook);
            continue;
        }
        environmentSelections.push({
            ...hook,
            driver: await resolveDriver(extensions, environment.id, hook.name),
        });
    }

    // An enabled Extension can provide a default environment hook. An explicit
    // Instance entry for the same provider overrides that default, but no
    // Instance configuration is required to use an automatic provider.
    const usedOrders = new Set(environmentSelections.map(({ order }) => order));
    const selectedNames = new Set(environmentSelections.map(({ name }) => name));
    for (const declaration of extensions.listDeclarations(environment.id)) {
        if (declaration.declaration.automatic !== true || selectedNames.has(declaration.id)) continue;
        const order = nextAutomaticOrder(usedOrders);
        if (order === undefined) {
            console.warn(`Automatic execution environment ${declaration.id} skipped: no free order.`);
            continue;
        }
        try {
            const driver = await resolveDriver(extensions, environment.id, declaration.id);
            environmentSelections.push({
                order,
                name: declaration.id,
                content: {},
                phase: "process",
                driver,
            });
            selectedNames.add(declaration.id);
            usedOrders.add(order);
        } catch (error) {
            // Automatic providers are optional: failure must not prevent an
            // otherwise healthy Worker from starting.
            console.warn(`Automatic execution environment ${declaration.id} unavailable:`, error);
        }
    }
    if (environmentSelections.length > (config.environment?.length ?? 0))
        environmentSelections.sort((left, right) => left.order - right.order);

    const selectedSandbox = config.sandbox;
    const sandboxSelection = selectedSandbox === undefined
        ? undefined
        : {
            ...selectedSandbox,
            driver: selectedSandbox.name === "bubblewrap"
                ? undefined
                : await resolveDriver(extensions, sandbox.id, selectedSandbox.name),
        };
    return {
        ...(config.environment === undefined && environmentSelections.length === 0
            ? {}
            : { environment: environmentSelections }),
        ...(sandboxSelection === undefined
            ? {}
            : { sandbox: sandboxSelection }),
    };
}

function nextAutomaticOrder(used: ReadonlySet<number>): number | undefined {
    const afterExplicit = Math.max(0, ...used) + 1;
    if (afterExplicit <= 999) return afterExplicit;
    for (let order = 999; order >= 1; order--) {
        if (!used.has(order)) return order;
    }
    return undefined;
}

async function resolveDriver(
    extensions: Pick<ExtensionRuntime, "acquireRegistration">,
    pointId: string,
    name: string,
): Promise<ExecutionDriverDescriptor> {
    const acquired = await extensions.acquireRegistration(pointId, name);
    try {
        const binding = acquired.registration.binding as ExecutionDriverDescriptor;
        if (binding.name !== name || binding.version !== 1) {
            throw new TypeError("Execution Provider " + pointId + "/" + name + " returned an invalid driver.");
        }
        return structuredClone(binding);
    } finally {
        acquired.lease.release();
    }
}
