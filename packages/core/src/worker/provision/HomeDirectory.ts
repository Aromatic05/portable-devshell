import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export function resolveWorkerHomeDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    platform = process.platform
): string {
    const configured = platform === "win32"
        ? resolveWindowsHomeDirectory(environment)
        : firstNonEmpty(environment.HOME, environment.USERPROFILE);
    if (configured !== undefined) {
        return configured;
    }

    const systemHome = homedir();
    if (systemHome.length === 0) {
        throw new Error("the current user home directory is unavailable");
    }
    return systemHome;
}

export function resolveWorkerDevshellHomeDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    platform = process.platform
): string {
    const configured = environment.PORTABLE_DEVSHELL_HOME;
    if (configured !== undefined && configured.length > 0) {
        return configured;
    }

    const homeDirectory = resolveWorkerHomeDirectory(environment, platform);
    return platform === "win32"
        ? win32.resolve(homeDirectory, ".devshell")
        : posix.resolve(homeDirectory, ".devshell");
}

function resolveWindowsHomeDirectory(environment: NodeJS.ProcessEnv): string | undefined {
    const userProfile = firstNonEmpty(environment.USERPROFILE);
    if (userProfile !== undefined) {
        return userProfile;
    }

    const homeDrive = firstNonEmpty(environment.HOMEDRIVE);
    const homePath = firstNonEmpty(environment.HOMEPATH);
    if (homeDrive !== undefined && homePath !== undefined) {
        return win32.resolve(`${homeDrive}\\`, homePath);
    }

    return firstNonEmpty(environment.HOME);
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
    return values.find((value): value is string => value !== undefined && value.length > 0);
}
