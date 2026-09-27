import { posix, win32 } from "node:path";

export function hostReleaseTarget(
    platform = process.platform,
    arch = process.arch,
) {
    const os =
        platform === "darwin"
            ? "darwin"
            : platform === "win32"
              ? "windows"
              : platform === "linux"
                ? "linux"
                : undefined;
    const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
    if (os === undefined || cpu === undefined)
        throw new Error(`unsupported host platform: ${platform}/${arch}`);
    return `${os}-${cpu}`;
}

export function resolveApplicationSmokeArchive(
    argv,
    cwd = process.cwd(),
    platform = process.platform,
    arch = process.arch,
) {
    const path = platform === "win32" ? win32 : posix;
    const inputs = argv.filter((argument) => argument !== "--");
    if (inputs.length > 1) {
        throw new Error(
            "smoke application accepts at most one <portable-devshell-app.tar.gz> argument",
        );
    }
    const candidate =
        inputs[0] ??
        path.resolve(
            cwd,
            "release-assets",
            `portable-devshell-app-${hostReleaseTarget(platform, arch)}.tar.gz`,
        );
    return path.isAbsolute(candidate)
        ? candidate
        : path.resolve(cwd, candidate);
}
