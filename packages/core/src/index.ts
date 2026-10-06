import {
    createInstanceRuntimeRegistry as createInstanceRuntimeRegistryInternal,
} from "./instance/index.js";
import type {
    InstanceRuntimeRegistry,
    InstanceRuntimeRegistryOptions,
} from "./instance/Api.js";

export { Instance } from "./instance/Instance.js";
export { InstanceRegistry } from "./instance/Registry.js";
export type {
    InstanceRuntime,
    InstanceRuntimeRegistry,
} from "./instance/Api.js";

export function createInstanceRuntimeRegistry(
    options: InstanceRuntimeRegistryOptions,
): InstanceRuntimeRegistry {
    return createInstanceRuntimeRegistryInternal(options);
}
