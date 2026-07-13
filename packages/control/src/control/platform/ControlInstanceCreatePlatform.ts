import type { InstanceCreateProvider } from "@portable-devshell/shared";

const unixProviders = ["local", "ssh", "docker", "podman", "reverse"] as const satisfies readonly InstanceCreateProvider[];
const windowsProviders = ["local", "ssh", "reverse"] as const satisfies readonly InstanceCreateProvider[];

export function instanceCreateProviders(platform = process.platform): readonly InstanceCreateProvider[] {
    return platform === "win32" ? windowsProviders : unixProviders;
}
