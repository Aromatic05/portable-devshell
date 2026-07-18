import { chmod, mkdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

const runtimeDirectoryName = "portable-devshell";
const windowsPipePrefix = "\\\\.\\pipe\\portable-devshell-control-";

export class ControlPathHome {
    readonly controlHomeDir: string;
    readonly artifactsDir: string;
    readonly configFile: string;
    readonly contextsFile: string;
    readonly instancesDir: string;
    readonly oauthDir: string;
    readonly reverseDir: string;

    constructor(homeDirectory = homedir()) {
        this.controlHomeDir = join(homeDirectory, ".devshell", "control");
        this.artifactsDir = join(this.controlHomeDir, "artifacts");
        this.configFile = join(this.controlHomeDir, "config.toml");
        this.contextsFile = join(this.controlHomeDir, "contexts.json");
        this.instancesDir = join(this.controlHomeDir, "instances");
        this.oauthDir = join(this.controlHomeDir, "oauth");
        this.reverseDir = join(this.controlHomeDir, "reverse");
    }

    instanceConfigFile(name: string): string {
        return join(this.instancesDir, `${name}.toml`);
    }

    reverseCredentialFile(name: string): string {
        return join(this.reverseDir, `${name}.json`);
    }
}

export class ControlPathRuntime {
    readonly runtimeDir: string;
    readonly socketFile: string;

    constructor(
        xdgRuntimeDir: string | undefined = undefined,
        platform = process.platform,
        environment: NodeJS.ProcessEnv = process.env
    ) {
        this.runtimeDir = resolveControlRuntimeDirectory(xdgRuntimeDir, platform, environment);
        this.socketFile = resolveControlSocketPath(xdgRuntimeDir, platform, environment);
    }
}

export interface ControlSocketFilePort {
    readonly path: string;
    readonly runtimeDir: string;
    ensureRuntimeDir(): Promise<void>;
    remove(): Promise<void>;
}

export class ControlSocketFile implements ControlSocketFilePort {
    readonly runtimeDir: string;
    readonly path: string;
    readonly #platform: string;

    constructor(
        xdgRuntimeDir: string | undefined = undefined,
        platform = process.platform,
        environment: NodeJS.ProcessEnv = process.env
    ) {
        const paths = new ControlPathRuntime(xdgRuntimeDir, platform, environment);
        this.runtimeDir = paths.runtimeDir;
        this.path = paths.socketFile;
        this.#platform = platform;
    }

    async ensureRuntimeDir(): Promise<void> {
        await mkdir(this.runtimeDir, {
            ...(this.#platform === "win32" ? {} : { mode: 0o700 }),
            recursive: true
        });
        if (this.#platform !== "win32") {
            await chmod(this.runtimeDir, 0o700);
        }
    }

    async remove(): Promise<void> {
        await removeControlIpcEndpoint(this.path);
    }
}

export function resolveControlRuntimeDirectory(
    xdgRuntimeDir: string | undefined = undefined,
    platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env
): string {
    if (platform === "win32") {
        const base = xdgRuntimeDir
            ?? environment.LOCALAPPDATA
            ?? environment.TEMP
            ?? environment.TMP
            ?? tmpdir();
        return win32.join(base, runtimeDirectoryName, "runtime");
    }
    const explicit = xdgRuntimeDir ?? environment.XDG_RUNTIME_DIR;
    if (explicit !== undefined && explicit.length > 0) {
        return posix.join(explicit, runtimeDirectoryName);
    }
    const temporaryDirectory = process.platform === "win32" ? "/tmp" : tmpdir();
    return posix.join(temporaryDirectory, `${runtimeDirectoryName}-${resolveUnixUserIdentity(environment)}`);
}

export function resolveControlSocketPath(
    xdgRuntimeDir: string | undefined = undefined,
    platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env
): string {
    return platform === "win32"
        ? `${windowsPipePrefix}${normalizeIdentity(environment.USERNAME ?? environment.USER ?? "user")}`
        : posix.join(resolveControlRuntimeDirectory(xdgRuntimeDir, platform, environment), "control.sock");
}

export function isWindowsNamedPipePath(path: string): boolean {
    return path.startsWith("\\\\.\\pipe\\");
}

export async function removeControlIpcEndpoint(
    path: string,
    unlinkFunction: (path: string) => Promise<unknown> = unlink
): Promise<void> {
    if (!isWindowsNamedPipePath(path)) {
        await unlinkFunction(path).catch(() => undefined);
    }
}

function resolveUnixUserIdentity(environment: NodeJS.ProcessEnv): string {
    return typeof process.getuid === "function"
        ? String(process.getuid())
        : normalizeIdentity(environment.USER ?? environment.USERNAME ?? "user");
}

function normalizeIdentity(value: string): string {
    const normalized = value.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
    return normalized.length === 0 ? "user" : normalized;
}
