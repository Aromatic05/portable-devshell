import type { ArtifactDirectoryArchiveLimits } from "../artifact/host/ArtifactHostArchive.js";

export interface ExtensionInstallLimits extends ArtifactDirectoryArchiveLimits {
    maxCompressedBytes: number;
}

export const DEFAULT_EXTENSION_INSTALL_LIMITS: ExtensionInstallLimits = {
    maxCompressedBytes: 64 * 1024 * 1024,
    maxEntries: 20_000,
    maxFileBytes: 64 * 1024 * 1024,
    maxLogicalBytes: 256 * 1024 * 1024
};

export function resolveExtensionInstallLimits(
    overrides: Partial<ExtensionInstallLimits> = {}
): ExtensionInstallLimits {
    const limits = {
        ...DEFAULT_EXTENSION_INSTALL_LIMITS,
        ...overrides
    };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new TypeError(`Extension install limit ${name} must be a positive safe integer.`);
        }
    }
    return limits;
}
