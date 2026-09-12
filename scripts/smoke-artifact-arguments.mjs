import { posix, win32 } from "node:path";

export function hostReleaseTarget(platform = process.platform, arch = process.arch) {
    const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : undefined;
    const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
    if (os === undefined || cpu === undefined) throw new Error(`unsupported host platform: ${platform}/${arch}`);
    return `${os}-${cpu}`;
}

export function resolveApplicationSmokeArchive(argv, cwd = process.cwd(), platform = process.platform, arch = process.arch) {
    const path = platform === "win32" ? win32 : posix;
    const inputs = argv.filter((argument) => argument !== "--");
    if (inputs.length > 1) {
        throw new Error("smoke application accepts at most one <portable-devshell-app.tar.gz> argument");
    }
    const candidate = inputs[0] ?? path.resolve(cwd, "release-assets", `portable-devshell-app-${hostReleaseTarget(platform, arch)}.tar.gz`);
    return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}

export function resolveAgentSmokeArtifacts(argv, cwd = process.cwd(), platform = process.platform, arch = process.arch) {
    const path = platform === "win32" ? win32 : posix;
    const inputs = argv.filter((argument) => argument !== "--");
    if (inputs.length !== 0 && inputs.length !== 5) {
        throw new Error("smoke Agent accepts either no arguments or <app> <agent.dsext> <pi.dsprovider> <opencode.dsprovider> <worker>");
    }
    if (inputs.length === 5) return inputs.map((value) => path.isAbsolute(value) ? value : path.resolve(cwd, value));

    const target = hostReleaseTarget(platform, arch);
    const suffix = platform === "win32" ? ".exe" : "";
    const assets = path.resolve(cwd, "release-assets");
    return [
        path.resolve(assets, `portable-devshell-app-${target}.tar.gz`),
        path.resolve(assets, "portable-devshell-agent.dsext"),
        path.resolve(assets, `portable-devshell-agent-provider-pi-${target}.dsprovider`),
        path.resolve(assets, `portable-devshell-agent-provider-opencode-${target}.dsprovider`),
        path.resolve(assets, `devshell-worker-${target}${suffix}`)
    ];
}
