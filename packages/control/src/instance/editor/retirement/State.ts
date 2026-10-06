import type { Instance } from "@portable-devshell/core";

export async function closeDescriptorResourcesBestEffort(
    descriptor: Instance,
    finalize: (descriptor: Instance) => Promise<void>,
): Promise<void> {
    await finalize(descriptor);
}
