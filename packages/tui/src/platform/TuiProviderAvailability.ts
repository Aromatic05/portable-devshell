import type { JsonValue } from "@portable-devshell/shared";

const unixEditableProviders = ["local", "ssh", "docker", "podman"] as const;
const windowsEditableProviders = ["local", "ssh"] as const;

export function editableProviderChoices(platform = process.platform): readonly JsonValue[] {
    return platform === "win32" ? windowsEditableProviders : unixEditableProviders;
}
