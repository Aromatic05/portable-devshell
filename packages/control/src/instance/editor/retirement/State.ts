import type { Instance } from "@portable-devshell/core/instance";

export async function closeDescriptorResourcesBestEffort(
    descriptor: Instance,
    finalize: (descriptor: Instance) => Promise<void>,
): Promise<void> {
    await finalize(descriptor);
}
