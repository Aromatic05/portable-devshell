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
    extensions: Pick<ExtensionRuntime, "acquireRegistration">,
    config: ControlExecutionConfig,
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
        ...(config.environment === undefined
            ? {}
            : { environment: environmentSelections }),
        ...(sandboxSelection === undefined
            ? {}
            : { sandbox: sandboxSelection }),
    };
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
