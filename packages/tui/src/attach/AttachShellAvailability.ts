export function isAttachShellSupported(
    provider: string | undefined,
    hostPlatform = process.platform
): boolean {
    if (provider !== "local" && provider !== "ssh" && provider !== "docker" && provider !== "podman") {
        return false;
    }

    if (hostPlatform === "win32" && provider !== "ssh") {
        return false;
    }

    return true;
}