export function isTuiTerminalSupported(
    provider: string | undefined
): boolean {
    return provider === "local" ||
        provider === "ssh" ||
        provider === "docker" ||
        provider === "podman" ||
        provider === "reverse";
}
